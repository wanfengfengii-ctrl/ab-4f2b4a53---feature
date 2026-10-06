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
