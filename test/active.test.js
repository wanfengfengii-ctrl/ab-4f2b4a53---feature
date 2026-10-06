// 活动固件切换与设备稳定地址取件的 HTTP 集成测试。
// 覆盖：首次切换前置版本须为 null、型号一致性、未知发布、expectedVersion 过期、
// 并发竞争唯一成功、重启保持、设备端 HEAD/Range/If-Range 语义与单响应版本一致性。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from '../src/server.js';

let root;
let server;
let base;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'fw-active-'));
  server = createServer({ dataDir: root, maxUploadBytes: 8 * 1024 * 1024 });
  await server.waitForReady();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function publish(version, targetModel, data) {
  const fd = new FormData();
  fd.set('version', version);
  fd.set('targetModel', targetModel);
  fd.set('sha256', sha(data));
  fd.set('artifact', new Blob([data], { type: 'application/octet-stream' }), `${version}.bin`);
  const r = await fetch(`${base}/api/firmware/releases`, { method: 'POST', body: fd });
  assert.equal(r.status, 201, `发布 ${version} 失败: ${await r.text()}`);
  return r;
}

const activeUrl = (m) => `${base}/api/firmware/models/${encodeURIComponent(m)}/active`;
const modelArtifact = (m) => `${base}/api/firmware/models/${encodeURIComponent(m)}/artifact`;
const releaseArtifact = (v) => `${base}/api/firmware/releases/${encodeURIComponent(v)}/artifact`;

function switchActive(model, releaseVersion, expectedVersion) {
  return fetch(activeUrl(model), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ releaseVersion, expectedVersion }),
  });
}

const MODEL = 'WT-ACTIVE-1';
const dataV1 = Buffer.from('active-v1-'.repeat(500));   // 5500 字节
const dataV2 = Buffer.from('active-v2-longer-'.repeat(400)); // 6800 字节，长度不同便于区分

test('未设置活动固件时，设备取件返回 404', async () => {
  const r = await fetch(modelArtifact('WT-NEVER-SET'));
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error.code, 'ACTIVE_NOT_FOUND');
});

test('首次切换要求 expectedVersion 为 null，否则 409 且不生效', async () => {
  await publish('1.0.0-active', MODEL, dataV1);
  const r = await switchActive(MODEL, '1.0.0-active', '9.9.9');
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error.code, 'VERSION_CONFLICT');
  // 活动版本仍未设置
  const g = await fetch(modelArtifact(MODEL));
  assert.equal(g.status, 404);
});

test('首次切换成功：返回活动版本与 ETag，设备随后取得该发布件', async () => {
  const r = await switchActive(MODEL, '1.0.0-active', null);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('etag'), `"${sha(dataV1)}"`);
  const body = await r.json();
  assert.equal(body.targetModel, MODEL);
  assert.equal(body.activeVersion, '1.0.0-active');
  assert.equal(body.previousVersion, null);
  assert.equal(body.sha256, sha(dataV1));

  const g = await fetch(modelArtifact(MODEL));
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('etag'), `"${sha(dataV1)}"`);
  assert.equal(Number(g.headers.get('content-length')), dataV1.length);
  const got = Buffer.from(await g.arrayBuffer());
  assert.ok(got.equals(dataV1));
});

test('未知发布版本返回 404，活动版本不变', async () => {
  const r = await switchActive(MODEL, '0.0.0-missing', '1.0.0-active');
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error.code, 'RELEASE_NOT_FOUND');
  const g = await fetch(modelArtifact(MODEL));
  assert.equal(g.headers.get('etag'), `"${sha(dataV1)}"`);
  await g.arrayBuffer();
});

test('型号不符的发布件不可切换（409），活动版本不变', async () => {
  const other = Buffer.from('other-model-fw');
  await publish('2.0.0-other', 'WT-OTHER', other);
  const r = await switchActive(MODEL, '2.0.0-other', '1.0.0-active');
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error.code, 'MODEL_MISMATCH');
  const g = await fetch(modelArtifact(MODEL));
  assert.equal(g.headers.get('etag'), `"${sha(dataV1)}"`);
  await g.arrayBuffer();
});

test('expectedVersion 过期返回 409，活动版本不变', async () => {
  await publish('2.0.0-active', MODEL, dataV2);
  const r = await switchActive(MODEL, '2.0.0-active', '0.0.0-stale');
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error.code, 'VERSION_CONFLICT');
  const g = await fetch(modelArtifact(MODEL));
  const got = Buffer.from(await g.arrayBuffer());
  assert.ok(got.equals(dataV1), '活动版本仍是切换前的完整发布件');
});

test('前置版本匹配时切换成功，设备从稳定地址取得新版本', async () => {
  const r = await switchActive(MODEL, '2.0.0-active', '1.0.0-active');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.activeVersion, '2.0.0-active');
  assert.equal(body.previousVersion, '1.0.0-active');
  assert.equal(r.headers.get('etag'), `"${sha(dataV2)}"`);

  const g = await fetch(modelArtifact(MODEL));
  assert.equal(g.headers.get('etag'), `"${sha(dataV2)}"`);
  const got = Buffer.from(await g.arrayBuffer());
  assert.ok(got.equals(dataV2));

  // 按版本下载不受影响：旧版本仍可完整下载
  const old = await fetch(releaseArtifact('1.0.0-active'));
  assert.equal(old.status, 200);
  const oldGot = Buffer.from(await old.arrayBuffer());
  assert.ok(oldGot.equals(dataV1));
});

test('重复同一切换（expectedVersion 已过期）返回 409', async () => {
  const r = await switchActive(MODEL, '2.0.0-active', '1.0.0-active');
  assert.equal(r.status, 409);
  // 幂等重试当前状态：expectedVersion 等于当前版本时切换同版本可成功
  const ok = await switchActive(MODEL, '2.0.0-active', '2.0.0-active');
  assert.equal(ok.status, 200);
});

test('并发切换只有一个成功，其余 409，活动版本为胜者', async () => {
  const model = 'WT-RACE';
  const dA = Buffer.from('race-A-'.repeat(300));
  const dB = Buffer.from('race-B-'.repeat(300));
  await publish('3.0.0-race-a', model, dA);
  await publish('3.0.0-race-b', model, dB);

  const results = await Promise.all([
    ...Array.from({ length: 4 }, () => switchActive(model, '3.0.0-race-a', null)),
    ...Array.from({ length: 4 }, () => switchActive(model, '3.0.0-race-b', null)),
  ]);
  const oks = results.filter((r) => r.status === 200);
  const conflicts = results.filter((r) => r.status === 409);
  assert.equal(oks.length, 1, `应只有一个成功，实际 ${oks.length}`);
  assert.equal(conflicts.length, results.length - 1);
  for (const c of conflicts) {
    assert.equal((await c.json()).error.code, 'VERSION_CONFLICT');
  }

  const winner = (await oks[0].json()).activeVersion;
  const winnerData = winner === '3.0.0-race-a' ? dA : dB;
  // 设备随后取得的只能是最后一次成功切换的完整发布件
  const g = await fetch(modelArtifact(model));
  const got = Buffer.from(await g.arrayBuffer());
  assert.equal(g.headers.get('etag'), `"${sha(winnerData)}"`);
  assert.ok(got.equals(winnerData));
});

test('切换与下载并发时，任一响应的字节与校验头同属一个版本', async () => {
  const model = 'WT-CONSIST';
  const d1 = Buffer.from('consist-1-'.repeat(1000));
  const d2 = Buffer.from('consist-2-'.repeat(1000));
  await publish('4.0.0-c1', model, d1);
  await publish('4.0.0-c2', model, d2);
  assert.equal((await switchActive(model, '4.0.0-c1', null)).status, 200);

  // 切换进行中并发全量/分段下载：每个响应的 sha256(字节) 必须等于其 ETag
  const jobs = [];
  jobs.push(switchActive(model, '4.0.0-c2', '4.0.0-c1'));
  for (let i = 0; i < 12; i++) {
    jobs.push((async () => {
      const r = await fetch(modelArtifact(model));
      assert.equal(r.status, 200);
      const etag = r.headers.get('etag');
      const buf = Buffer.from(await r.arrayBuffer());
      assert.equal(etag, `"${sha(buf)}"`, '响应字节与 ETag 必须同属一个版本');
      assert.ok(buf.equals(d1) || buf.equals(d2), '字节必须是某个完整发布件，不得拼接');
    })());
    jobs.push((async () => {
      const r = await fetch(modelArtifact(model), { headers: { Range: 'bytes=0-99' } });
      assert.equal(r.status, 206);
      const etag = r.headers.get('etag');
      const buf = Buffer.from(await r.arrayBuffer());
      const src = `"${sha(d1)}"` === etag ? d1 : d2;
      assert.ok(`"${sha(src)}"` === etag);
      assert.ok(buf.equals(src.subarray(0, 100)), '分段字节与 ETag 所示版本一致');
    })());
  }
  await Promise.all(jobs);

  const g = await fetch(modelArtifact(model));
  const got = Buffer.from(await g.arrayBuffer());
  assert.ok(got.equals(d2), '切换完成后设备取得新版本');
});

test('设备端下载复用 HEAD/Range/If-Range/416 语义', async () => {
  const url = modelArtifact(MODEL); // 当前活动为 2.0.0-active → dataV2
  const etag = `"${sha(dataV2)}"`;

  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), dataV2.length);
  assert.equal(head.headers.get('etag'), etag);
  assert.equal(await head.text(), '');

  const part = await fetch(url, { headers: { Range: 'bytes=10-99' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 10-99/${dataV2.length}`);
  assert.equal(part.headers.get('etag'), etag);
  const partBuf = Buffer.from(await part.arrayBuffer());
  assert.ok(partBuf.equals(dataV2.subarray(10, 100)));

  const suffix = await fetch(url, { headers: { Range: 'bytes=-50' } });
  assert.equal(suffix.status, 206);
  const suffixBuf = Buffer.from(await suffix.arrayBuffer());
  assert.ok(suffixBuf.equals(dataV2.subarray(dataV2.length - 50)));

  const unsat = await fetch(url, { headers: { Range: `bytes=${dataV2.length}-` } });
  assert.equal(unsat.status, 416);
  assert.equal(unsat.headers.get('content-range'), `bytes */${dataV2.length}`);
  await unsat.arrayBuffer();

  // If-Range 命中当前活动版本 → 206；不命中 → 完整 200
  const hit = await fetch(url, { headers: { Range: 'bytes=0-9', 'If-Range': etag } });
  assert.equal(hit.status, 206);
  await hit.arrayBuffer();
  const miss = await fetch(url, { headers: { Range: 'bytes=0-9', 'If-Range': '"stale"' } });
  assert.equal(miss.status, 200);
  const missBuf = Buffer.from(await miss.arrayBuffer());
  assert.ok(missBuf.equals(dataV2));

  const inm = await fetch(url, { headers: { 'If-None-Match': etag } });
  assert.equal(inm.status, 304);
});

test('活动映射经重启保持，设备仍取得最后成功切换的发布件', async () => {
  const s2 = createServer({ dataDir: root, maxUploadBytes: 8 * 1024 * 1024 });
  await s2.waitForReady();
  await new Promise((resolve) => s2.listen(0, '127.0.0.1', resolve));
  try {
    const p2 = `http://127.0.0.1:${s2.address().port}`;
    const g = await fetch(`${p2}/api/firmware/models/${MODEL}/artifact`);
    assert.equal(g.status, 200);
    assert.equal(g.headers.get('etag'), `"${sha(dataV2)}"`);
    const got = Buffer.from(await g.arrayBuffer());
    assert.ok(got.equals(dataV2));

    // 重启后继续切换：前置版本仍为磁盘上保持的活动版本
    const d3 = Buffer.from('after-restart-'.repeat(200));
    const fd = new FormData();
    fd.set('version', '5.0.0-active');
    fd.set('targetModel', MODEL);
    fd.set('sha256', sha(d3));
    fd.set('artifact', new Blob([d3]), '5.0.0-active.bin');
    assert.equal((await fetch(`${p2}/api/firmware/releases`, { method: 'POST', body: fd })).status, 201);
    const sw = await fetch(`${p2}/api/firmware/models/${MODEL}/active`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ releaseVersion: '5.0.0-active', expectedVersion: '2.0.0-active' }),
    });
    assert.equal(sw.status, 200);
    const g2 = await fetch(`${p2}/api/firmware/models/${MODEL}/artifact`);
    const got2 = Buffer.from(await g2.arrayBuffer());
    assert.ok(got2.equals(d3));
  } finally {
    await new Promise((resolve) => s2.close(resolve));
  }
});

test('切换请求的参数校验', async () => {
  // 非 JSON 内容类型 → 415
  const notJson = await fetch(activeUrl(MODEL), {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'x',
  });
  assert.equal(notJson.status, 415);

  // 非法 JSON → 400
  const badJson = await fetch(activeUrl(MODEL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{oops',
  });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error.code, 'INVALID_JSON');

  // 缺 releaseVersion → 400
  const noVer = await fetch(activeUrl(MODEL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: null }),
  });
  assert.equal(noVer.status, 400);

  // expectedVersion 类型非法 → 400
  const badExp = await fetch(activeUrl(MODEL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ releaseVersion: '2.0.0-active', expectedVersion: 42 }),
  });
  assert.equal(badExp.status, 400);
  assert.equal((await badExp.json()).error.code, 'INVALID_EXPECTED_VERSION');

  // GET 活动端点 → 405
  const wrongMethod = await fetch(activeUrl(MODEL));
  assert.equal(wrongMethod.status, 405);
});
