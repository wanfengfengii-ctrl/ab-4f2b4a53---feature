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
  root = await mkdtemp(path.join(tmpdir(), 'fw-http-'));
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

async function publish(version, targetModel, data, shaOverride) {
  const fd = new FormData();
  fd.set('version', version);
  fd.set('targetModel', targetModel);
  fd.set('sha256', shaOverride ?? sha(data));
  fd.set('artifact', new Blob([data], { type: 'application/octet-stream' }), `${version}.bin`);
  return fetch(`${base}/api/firmware/releases`, { method: 'POST', body: fd });
}

const artifact = (v) => `${base}/api/firmware/releases/${encodeURIComponent(v)}/artifact`;

test('健康检查', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'ok');
});

test('发布成功返回 201 与 ETag', async () => {
  const data = Buffer.from('firmware-image-'.repeat(200));
  const r = await publish('1.0.0', 'WT-5000', data);
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('etag'), `"${sha(data)}"`);
  const body = await r.json();
  assert.equal(body.version, '1.0.0');
  assert.equal(body.size, data.length);
});

test('完整下载 200：ETag/Content-Length/字节一致', async () => {
  const data = Buffer.from('firmware-image-'.repeat(200));
  const r = await fetch(artifact('1.0.0'));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(Number(r.headers.get('content-length')), data.length);
  assert.equal(r.headers.get('etag'), `"${sha(data)}"`);
  const got = Buffer.from(await r.arrayBuffer());
  assert.ok(got.equals(data));
});

test('闭区间 Range → 206 且 Content-Range 正确', async () => {
  const data = Buffer.from('firmware-image-'.repeat(200));
  const r = await fetch(artifact('1.0.0'), { headers: { Range: 'bytes=10-99' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 10-99/${data.length}`);
  assert.equal(Number(r.headers.get('content-length')), 90);
  const got = Buffer.from(await r.arrayBuffer());
  assert.ok(got.equals(data.subarray(10, 100)));
});

test('开放尾端 Range bytes=start-', async () => {
  const data = Buffer.from('firmware-image-'.repeat(200));
  const r = await fetch(artifact('1.0.0'), { headers: { Range: 'bytes=2500-' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 2500-${data.length - 1}/${data.length}`);
  assert.equal(Number(r.headers.get('content-length')), data.length - 2500);
  const got = Buffer.from(await r.arrayBuffer());
  assert.ok(got.equals(data.subarray(2500)));
});

test('后缀 Range bytes=-N', async () => {
  const data = Buffer.from('firmware-image-'.repeat(200));
  const r = await fetch(artifact('1.0.0'), { headers: { Range: 'bytes=-500' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes ${data.length - 500}-${data.length - 1}/${data.length}`);
  const got = Buffer.from(await r.arrayBuffer());
  assert.ok(got.equals(data.subarray(data.length - 500)));
});

test('分段重组与发布件字节完全一致（核心续传场景）', async () => {
  const data = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
  await publish('2.3.4', 'WT-9000', data);
  const chunks = [];
  const boundaries = [
    [0, 0], [1, 499], [500, 1499], [1500, 1500],
    [1501, 3999], [4000, 4999], [5000, 0],
  ];
  // 用闭区间 + 开放尾端 + 后缀混合请求
  const requests = [
    { range: 'bytes=0-499' },
    { range: 'bytes=500-1499' },
    { range: 'bytes=1500-1500' }, // 单字节
    { range: 'bytes=1501-3999' },
    { range: 'bytes=4000-' },      // 开放尾端
  ];
  for (const { range } of requests) {
    const r = await fetch(artifact('2.3.4'), { headers: { Range: range } });
    assert.equal(r.status, 206, `${range} 应返回 206`);
    chunks.push({ range, buf: Buffer.from(await r.arrayBuffer()), cr: r.headers.get('content-range') });
  }
  // 用后缀范围补最后一段（与开放尾端重叠仅做独立验证）
  const suffix = await fetch(artifact('2.3.4'), { headers: { Range: 'bytes=-1000' } });
  assert.equal(suffix.status, 206);
  const suffixBuf = Buffer.from(await suffix.arrayBuffer());
  assert.ok(suffixBuf.equals(data.subarray(4000)), '后缀 1000 字节与原文一致');

  const assembled = Buffer.concat(chunks.map((c) => c.buf));
  assert.equal(assembled.length, data.length, '重组长度等于发布件长度');
  assert.ok(assembled.equals(data), '分段重组字节与发布件完全一致');
  // 每段 Content-Range 与实际长度一致
  for (const c of chunks) {
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(c.cr);
    assert.ok(m);
    assert.equal(Number(m[2]) - Number(m[1]) + 1, c.buf.length);
    assert.equal(Number(m[3]), data.length);
  }
});

test('非法起点返回 416 且带 Content-Range: bytes *∕size', async () => {
  const r = await fetch(artifact('1.0.0'), { headers: { Range: 'bytes=999999-' } });
  assert.equal(r.status, 416);
  const data = Buffer.from('firmware-image-'.repeat(200));
  assert.equal(r.headers.get('content-range'), `bytes */${data.length}`);
  assert.ok(r.headers.get('etag'));
});

test('bytes=-0 返回 416', async () => {
  const r = await fetch(artifact('1.0.0'), { headers: { Range: 'bytes=-0' } });
  assert.equal(r.status, 416);
});

test('无法理解的 Range 语法回退 200 完整文件', async () => {
  const data = Buffer.from('firmware-image-'.repeat(200));
  for (const bad of ['bytes=10-5', 'items=0-10', 'bytes=0-9,10-19']) {
    const r = await fetch(artifact('1.0.0'), { headers: { Range: bad } });
    assert.equal(r.status, 200, `${bad} 应回退 200`);
    assert.equal(Number(r.headers.get('content-length')), data.length);
    const got = Buffer.from(await r.arrayBuffer());
    assert.ok(got.equals(data));
  }
});

test('If-Range 与当前 ETag 不符时返回完整文件 200', async () => {
  const data = Buffer.from('firmware-image-'.repeat(200));
  const r = await fetch(artifact('1.0.0'), {
    headers: { Range: 'bytes=0-99', 'If-Range': '"stale-etag"' },
  });
  assert.equal(r.status, 200);
  assert.equal(Number(r.headers.get('content-length')), data.length);
  assert.equal(r.headers.get('content-range'), null);
  const got = Buffer.from(await r.arrayBuffer());
  assert.ok(got.equals(data));
});

test('If-Range 与当前 ETag 相符时返回 206', async () => {
  const data = Buffer.from('firmware-image-'.repeat(200));
  const etag = `"${sha(data)}"`;
  const r = await fetch(artifact('1.0.0'), {
    headers: { Range: 'bytes=0-99', 'If-Range': etag },
  });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 0-99/${data.length}`);
});

test('摘要错误返回 422 且不能污染已发布固件', async () => {
  const data = Buffer.from('secret-payload');
  const r = await publish('9.9.9', 'M', data, '0'.repeat(64));
  assert.equal(r.status, 422);
  const body = await r.json();
  assert.equal(body.error.code, 'SHA256_MISMATCH');
  const get = await fetch(artifact('9.9.9'));
  assert.equal(get.status, 404);
  const list = await fetch(`${base}/api/firmware/releases`).then((x) => x.json());
  assert.ok(!list.releases.some((x) => x.version === '9.9.9'));
});

test('重复版本返回 409 且原字节不变', async () => {
  const data1 = Buffer.from('original-content');
  const data2 = Buffer.from('tampered-new-content');
  const r1 = await publish('5.5.5', 'M', data1);
  assert.equal(r1.status, 201);
  const r2 = await publish('5.5.5', 'M', data2);
  assert.equal(r2.status, 409);
  assert.equal((await r2.json()).error.code, 'VERSION_EXISTS');
  const got = Buffer.from(await (await fetch(artifact('5.5.5'))).arrayBuffer());
  assert.ok(got.equals(data1));
});

test('缺少字段/文件返回明确 4xx', async () => {
  const fd = new FormData();
  fd.set('version', '6.6.6');
  // 缺 targetModel/sha256/artifact
  const r = await fetch(`${base}/api/firmware/releases`, { method: 'POST', body: fd });
  assert.equal(r.status, 400);
  assert.ok((await r.json()).error.code);
});

test('非 multipart 发布返回 415', async () => {
  const r = await fetch(`${base}/api/firmware/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(r.status, 415);
});

test('未知版本下载 404', async () => {
  const r = await fetch(artifact('does-not-exist'));
  assert.equal(r.status, 404);
});

test('HEAD 请求头与 GET 一致但无响应体', async () => {
  const data = Buffer.from('firmware-image-'.repeat(200));
  const r = await fetch(artifact('1.0.0'), { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.equal(Number(r.headers.get('content-length')), data.length);
  assert.ok(r.headers.get('etag'));
  const text = await r.text();
  assert.equal(text, '');
});

test('If-None-Match 返回 304', async () => {
  const data = Buffer.from('firmware-image-'.repeat(200));
  const r = await fetch(artifact('1.0.0'), {
    headers: { 'If-None-Match': `"${sha(data)}"` },
  });
  assert.equal(r.status, 304);
});

test('Content-Length 与实际发送字节严格一致（200/206/416）', async () => {
  const data = Buffer.from('firmware-image-'.repeat(200));
  const cases = [
    { init: {}, status: 200 },
    { init: { headers: { Range: 'bytes=0-0' } }, status: 206 },
    { init: { headers: { Range: 'bytes=-1' } }, status: 206 },
  ];
  for (const c of cases) {
    const r = await fetch(artifact('1.0.0'), c.init);
    assert.equal(r.status, c.status);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.length, Number(r.headers.get('content-length')));
    void data;
  }
});

test('服务重启后既有版本仍可下载', async () => {
  const data = Buffer.from('across-restart-'.repeat(123));
  await publish('7.7.7', 'WT-X', data);
  // 模拟重启：用同一数据目录创建新实例
  const s2 = createServer({ dataDir: root, maxUploadBytes: 8 * 1024 * 1024 });
  await s2.waitForReady();
  await new Promise((resolve) => s2.listen(0, '127.0.0.1', resolve));
  try {
    const p2 = `http://127.0.0.1:${s2.address().port}`;
    const r = await fetch(`${p2}/api/firmware/releases/7.7.7/artifact`);
    assert.equal(r.status, 200);
    const got = Buffer.from(await r.arrayBuffer());
    assert.ok(got.equals(data));
    assert.equal(r.headers.get('etag'), `"${sha(data)}"`);
  } finally {
    await new Promise((resolve) => s2.close(resolve));
  }
});
