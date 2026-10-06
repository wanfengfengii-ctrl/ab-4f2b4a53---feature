import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FirmwareStore, StoreError } from '../src/store.js';

let root;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'fw-store-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function makeTmpFile(dir, buf) {
  const p = path.join(dir, `${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(p, buf);
  return p;
}

test('发布成功：校验、落盘、元数据一致', async () => {
  const dataDir = path.join(root, 'ok');
  const store = new FirmwareStore(dataDir);
  await store.init();
  const data = Buffer.from('firmware payload'.repeat(100));
  const tmp = await makeTmpFile(dataDir, data);
  const meta = await store.publish({
    fields: { version: '1.0.0', targetModel: 'WT-5000', sha256: sha(data) },
    file: {
      path: tmp, size: data.length, sha256: sha(data),
      filename: 'fw-1.0.0.bin', contentType: 'application/octet-stream',
    },
  });
  assert.equal(meta.version, '1.0.0');
  assert.equal(meta.size, data.length);
  assert.equal(meta.sha256, sha(data));
  const onDisk = await readFile(store.artifactPath('1.0.0'));
  assert.ok(onDisk.equals(data));
  // staging 应被清理
  assert.deepEqual(await readdir(path.join(dataDir, 'staging')), []);
});

test('摘要不符抛 422 且不污染发布区', async () => {
  const dataDir = path.join(root, 'badsha');
  const store = new FirmwareStore(dataDir);
  await store.init();
  const data = Buffer.from('abc');
  const tmp = await makeTmpFile(dataDir, data);
  const wrong = '0'.repeat(64);
  await assert.rejects(
    store.publish({
      fields: { version: '2.0.0', targetModel: 'M', sha256: wrong },
      file: { path: tmp, size: 3, sha256: sha(data), filename: 'a', contentType: 'x' },
    }),
    (err) => err instanceof StoreError && err.status === 422 && err.code === 'SHA256_MISMATCH',
  );
  assert.equal(store.get('2.0.0'), null);
  assert.deepEqual(await readdir(path.join(dataDir, 'releases')), []);
});

test('重复版本抛 409 且不可覆盖', async () => {
  const dataDir = path.join(root, 'dup');
  const store = new FirmwareStore(dataDir);
  await store.init();
  const data1 = Buffer.from('one');
  const data2 = Buffer.from('two-different-content');
  const t1 = await makeTmpFile(dataDir, data1);
  await store.publish({
    fields: { version: '3.0.0', targetModel: 'M', sha256: sha(data1) },
    file: { path: t1, size: data1.length, sha256: sha(data1), filename: 'a', contentType: 'x' },
  });
  const t2 = await makeTmpFile(dataDir, data2);
  await assert.rejects(
    store.publish({
      fields: { version: '3.0.0', targetModel: 'M', sha256: sha(data2) },
      file: { path: t2, size: data2.length, sha256: sha(data2), filename: 'b', contentType: 'x' },
    }),
    (err) => err.status === 409 && err.code === 'VERSION_EXISTS',
  );
  // 原文件字节不变
  const onDisk = await readFile(store.artifactPath('3.0.0'));
  assert.ok(onDisk.equals(data1));
});

test('非法字段返回 400', async () => {
  const dataDir = path.join(root, 'invalid');
  const store = new FirmwareStore(dataDir);
  await store.init();
  const data = Buffer.from('x');
  const base = {
    fields: { version: 'ok-version', targetModel: 'M', sha256: sha(data) },
    file: { path: await makeTmpFile(dataDir, data), size: 1, sha256: sha(data), filename: 'a', contentType: 'x' },
  };
  for (const bad of [
    { version: '' },
    { version: 'bad/version' },
    { version: 'a'.repeat(65) },
    { targetModel: '' },
    { sha256: 'xyz' },
  ]) {
    const data2 = Buffer.from('y');
    const attempt = {
      fields: { ...base.fields, ...bad },
      file: { ...base.file, path: await makeTmpFile(dataDir, data2), sha256: sha(data2), size: 1 },
    };
    await assert.rejects(
      store.publish(attempt),
      (err) => err instanceof StoreError && err.status === 400,
      JSON.stringify(bad),
    );
  }
});

test('重启后既有版本仍可下载，残留 staging 被清理', async () => {
  const dataDir = path.join(root, 'restart');
  const s1 = new FirmwareStore(dataDir);
  await s1.init();
  const data = Buffer.from('persist-me-持久化'.repeat(50));
  const tmp = await makeTmpFile(dataDir, data);
  await s1.publish({
    fields: { version: '4.0.0', targetModel: 'M', sha256: sha(data) },
    file: { path: tmp, size: data.length, sha256: sha(data), filename: 'a', contentType: 'x' },
  });
  // 模拟崩溃残留
  await rm(path.join(dataDir, 'staging'), { recursive: true, force: true });

  const s2 = new FirmwareStore(dataDir);
  await s2.init();
  const meta = s2.get('4.0.0');
  assert.ok(meta);
  assert.equal(meta.sha256, sha(data));
  const onDisk = await readFile(s2.artifactPath('4.0.0'));
  assert.ok(onDisk.equals(data));
  assert.deepEqual(await readdir(path.join(dataDir, 'staging')), []);
});

async function publishRelease(store, dataDir, version, targetModel, data) {
  const tmp = await makeTmpFile(dataDir, data);
  return store.publish({
    fields: { version, targetModel, sha256: sha(data) },
    file: { path: tmp, size: data.length, sha256: sha(data), filename: `${version}.bin`, contentType: 'x' },
  });
}

test('活动切换：首次须 expectedVersion=null，再次切换须匹配前置版本', async () => {
  const dataDir = path.join(root, 'active-ok');
  const store = new FirmwareStore(dataDir);
  await store.init();
  await publishRelease(store, dataDir, '1.0.0', 'WT-A', Buffer.from('a-one'));
  await publishRelease(store, dataDir, '1.1.0', 'WT-A', Buffer.from('a-two'));

  // 首次切换误传字符串 → 409
  await assert.rejects(
    store.setActive('WT-A', '1.0.0', '0.9.0'),
    (err) => err.status === 409 && err.code === 'VERSION_CONFLICT',
  );
  assert.equal(store.getActive('WT-A'), null);

  // 首次切换 null → 成功
  const rec1 = await store.setActive('WT-A', '1.0.0', null);
  assert.equal(rec1.version, '1.0.0');
  assert.equal(store.getActiveMeta('WT-A').version, '1.0.0');

  // 前置版本过期（null 或错误版本）→ 409，活动版本不变
  await assert.rejects(
    store.setActive('WT-A', '1.1.0', null),
    (err) => err.status === 409 && err.code === 'VERSION_CONFLICT',
  );
  await assert.rejects(
    store.setActive('WT-A', '1.1.0', '9.9.9'),
    (err) => err.status === 409 && err.code === 'VERSION_CONFLICT',
  );
  assert.equal(store.getActive('WT-A').version, '1.0.0');

  // 正确前置版本 → 成功
  const rec2 = await store.setActive('WT-A', '1.1.0', '1.0.0');
  assert.equal(rec2.version, '1.1.0');
  assert.equal(store.getActiveMeta('WT-A').version, '1.1.0');
});

test('活动切换：未知发布 404、型号不符 409', async () => {
  const dataDir = path.join(root, 'active-errors');
  const store = new FirmwareStore(dataDir);
  await store.init();
  await publishRelease(store, dataDir, '2.0.0', 'WT-A', Buffer.from('a'));

  await assert.rejects(
    store.setActive('WT-A', 'nope', null),
    (err) => err.status === 404 && err.code === 'RELEASE_NOT_FOUND',
  );
  // 型号一致的发布件才能切到该型号
  await assert.rejects(
    store.setActive('WT-B', '2.0.0', null),
    (err) => err.status === 409 && err.code === 'MODEL_MISMATCH',
  );
  assert.equal(store.getActive('WT-A'), null);
  assert.equal(store.getActive('WT-B'), null);
});

test('并发切换同一型号：仅一个成功，其余 409 且活动版本停留在成功版本', async () => {
  const dataDir = path.join(root, 'active-race');
  const store = new FirmwareStore(dataDir);
  await store.init();
  await publishRelease(store, dataDir, '1.0.0', 'WT-RACE', Buffer.from('r1'));
  await publishRelease(store, dataDir, '1.0.1', 'WT-RACE', Buffer.from('r2'));

  // 两个请求都以 null 为前置：首次只能一个赢
  const results = await Promise.allSettled([
    store.setActive('WT-RACE', '1.0.0', null),
    store.setActive('WT-RACE', '1.0.1', null),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.status, 409);
  assert.equal(rejected[0].reason.code, 'VERSION_CONFLICT');
  const winner = fulfilled[0].value.version;
  assert.equal(store.getActive('WT-RACE').version, winner);

  // 链式竞争：双方都以赢家版本为前置切向不同新版本，同样只能一个赢
  await publishRelease(store, dataDir, '1.1.0', 'WT-RACE', Buffer.from('r3'));
  await publishRelease(store, dataDir, '1.2.0', 'WT-RACE', Buffer.from('r4'));
  const race2 = await Promise.allSettled([
    store.setActive('WT-RACE', '1.1.0', winner),
    store.setActive('WT-RACE', '1.2.0', winner),
  ]);
  assert.equal(race2.filter((r) => r.status === 'fulfilled').length, 1);
  const loser = race2.find((r) => r.status === 'rejected').reason;
  assert.equal(loser.status, 409);
  assert.equal(loser.code, 'VERSION_CONFLICT');
  assert.ok(['1.1.0', '1.2.0'].includes(store.getActive('WT-RACE').version));
});

test('不同型号的活动映射互不影响', async () => {
  const dataDir = path.join(root, 'active-multi');
  const store = new FirmwareStore(dataDir);
  await store.init();
  await publishRelease(store, dataDir, '1.0.0', 'WT-A', Buffer.from('a'));
  await publishRelease(store, dataDir, '3.0.0', 'WT-B', Buffer.from('b'));
  await store.setActive('WT-A', '1.0.0', null);
  await store.setActive('WT-B', '3.0.0', null);
  assert.equal(store.getActiveMeta('WT-A').version, '1.0.0');
  assert.equal(store.getActiveMeta('WT-B').version, '3.0.0');
});

test('活动映射经重启保持，且仍指向同一不可变发布件', async () => {
  const dataDir = path.join(root, 'active-restart');
  const s1 = new FirmwareStore(dataDir);
  await s1.init();
  const d1 = Buffer.from('active-persist-壹');
  const d2 = Buffer.from('active-persist-贰');
  await publishRelease(s1, dataDir, '1.0.0', 'WT-P', d1);
  await publishRelease(s1, dataDir, '2.0.0', 'WT-P', d2);
  await s1.setActive('WT-P', '1.0.0', null);
  await s1.setActive('WT-P', '2.0.0', '1.0.0');

  const s2 = new FirmwareStore(dataDir);
  await s2.init();
  const rec = s2.getActive('WT-P');
  assert.ok(rec);
  assert.equal(rec.version, '2.0.0');
  assert.equal(rec.targetModel, 'WT-P');
  const meta = s2.getActiveMeta('WT-P');
  assert.equal(meta.sha256, sha(d2));
  const onDisk = await readFile(s2.artifactPath('2.0.0'));
  assert.ok(onDisk.equals(d2));
});
