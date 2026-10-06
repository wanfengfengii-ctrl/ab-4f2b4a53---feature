import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
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
  assert.equal(r.status, 201, `发布 ${version} 应成功：${await r.text()}`);
  return r;
}

const switchUrl = (m) => `${base}/api/firmware/models/${encodeURIComponent(m)}/active`;
const stableUrl = (m) => `${base}/api/firmware/models/${encodeURIComponent(m)}/artifact`;

async function switchActive(model, body, init = {}) {
  return fetch(switchUrl(model), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
}

const V1 = Buffer.from('model-active-v1-'.repeat(200));
const V2 = Buffer.from('model-active-v2-'.repeat(200));
const OTHER = Buffer.from('other-model-only-'.repeat(100));

test('准备：发布同型号两个版本与另一型号版本', async () => {
  await publish('10.0.0', 'WT-ACTIVE', V1);
  await publish('10.1.0', 'WT-ACTIVE', V2);
  await publish('20.0.0', 'WT-OTHER', OTHER);
});

test('切换前稳定地址 404', async () => {
  const r = await fetch(stableUrl('WT-NEVER'));
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error.code, 'ACTIVE_RELEASE_NOT_FOUND');
});

test('首次切换 expectedVersion 必须为 null，成功返回活动版本与 ETag', async () => {
  const bad = await switchActive('WT-ACTIVE', { releaseVersion: '10.0.0', expectedVersion: '9.0.0' });
  assert.equal(bad.status, 409);
  assert.equal((await bad.json()).error.code, 'VERSION_CONFLICT');

  const ok = await switchActive('WT-ACTIVE', { releaseVersion: '10.0.0', expectedVersion: null });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('etag'), `"${sha(V1)}"`);
  const body = await ok.json();
  assert.equal(body.activeVersion, '10.0.0');
  assert.equal(body.targetModel, 'WT-ACTIVE');
  assert.equal(body.sha256, sha(V1));
  assert.ok(typeof body.switchedAt === 'string' && body.switchedAt);
});

test('未知发布版本 → 404 且不改活动版本', async () => {
  const r = await switchActive('WT-ACTIVE', { releaseVersion: 'no-such', expectedVersion: null });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error.code, 'RELEASE_NOT_FOUND');
});

test('型号不符的发布件不能切换 → 409 MODEL_MISMATCH', async () => {
  // 20.0.0 属于 WT-OTHER，不能切给 WT-ACTIVE
  const r = await switchActive('WT-ACTIVE', { releaseVersion: '20.0.0', expectedVersion: '10.0.0' });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error.code, 'MODEL_MISMATCH');

  // 反向：WT-ACTIVE 的版本也不能切给 WT-OTHER 的首切
  const r2 = await switchActive('WT-OTHER', { releaseVersion: '10.0.0', expectedVersion: null });
  assert.equal(r2.status, 409);
  assert.equal((await r2.json()).error.code, 'MODEL_MISMATCH');
});

test('前置版本过期 → 409 且活动版本不变', async () => {
  const stale = await switchActive('WT-ACTIVE', { releaseVersion: '10.1.0', expectedVersion: '9.9.9' });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'VERSION_CONFLICT');
  // 首切语义对已切换型号同样拒绝 null
  const nullAgain = await switchActive('WT-ACTIVE', { releaseVersion: '10.1.0', expectedVersion: null });
  assert.equal(nullAgain.status, 409);

  const still = await fetch(stableUrl('WT-ACTIVE'));
  assert.equal(still.status, 200);
  assert.equal(still.headers.get('etag'), `"${sha(V1)}"`);
});

test('稳定地址全量下载：200、ETag/字节属于当前活动版本', async () => {
  const r = await fetch(stableUrl('WT-ACTIVE'));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(Number(r.headers.get('content-length')), V1.length);
  assert.equal(r.headers.get('etag'), `"${sha(V1)}"`);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(V1));
});

test('稳定地址复用 HEAD/Range/206/416/If-Range 语义', async () => {
  const url = stableUrl('WT-ACTIVE');

  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), V1.length);
  assert.equal(head.headers.get('etag'), `"${sha(V1)}"`);
  assert.equal(await head.text(), '');

  const part = await fetch(url, { headers: { Range: 'bytes=10-109' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 10-109/${V1.length}`);
  assert.equal(part.headers.get('etag'), `"${sha(V1)}"`);
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(V1.subarray(10, 110)));

  const suffix = await fetch(url, { headers: { Range: 'bytes=-64' } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get('content-range'), `bytes ${V1.length - 64}-${V1.length - 1}/${V1.length}`);
  assert.ok(Buffer.from(await suffix.arrayBuffer()).equals(V1.subarray(V1.length - 64)));

  const unsat = await fetch(url, { headers: { Range: `bytes=${V1.length}-` } });
  assert.equal(unsat.status, 416);
  assert.equal(unsat.headers.get('content-range'), `bytes */${V1.length}`);
  assert.equal(unsat.headers.get('etag'), `"${sha(V1)}"`);
  await unsat.arrayBuffer().catch(() => {});

  // 切换响应里的 ETag 可直接用作 If-Range：相符 → 206；不符 → 完整 200
  const matched = await fetch(url, {
    headers: { Range: 'bytes=0-49', 'If-Range': `"${sha(V1)}"` },
  });
  assert.equal(matched.status, 206);

  const staleIfRange = await fetch(url, {
    headers: { Range: 'bytes=0-49', 'If-Range': '"stale"' },
  });
  assert.equal(staleIfRange.status, 200);
  assert.equal(Number(staleIfRange.headers.get('content-length')), V1.length);
});

test('成功切换后设备取得新活动版本的完整发布件', async () => {
  const r = await switchActive('WT-ACTIVE', { releaseVersion: '10.1.0', expectedVersion: '10.0.0' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('etag'), `"${sha(V2)}"`);
  assert.equal((await r.json()).activeVersion, '10.1.0');

  const got = await fetch(stableUrl('WT-ACTIVE'));
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('etag'), `"${sha(V2)}"`);
  assert.ok(Buffer.from(await got.arrayBuffer()).equals(V2));

  // 分段下载重组后仍是完整的新版本发布件，字节与校验头同属一版
  const ranges = ['bytes=0-999', 'bytes=1000-1999', 'bytes=2000-'];
  const chunks = [];
  for (const range of ranges) {
    const pr = await fetch(stableUrl('WT-ACTIVE'), {
      headers: { Range: range, 'If-Range': `"${sha(V2)}"` },
    });
    assert.equal(pr.status, 206, `${range} 应 206`);
    assert.equal(pr.headers.get('etag'), `"${sha(V2)}"`);
    chunks.push(Buffer.from(await pr.arrayBuffer()));
  }
  const assembled = Buffer.concat(chunks);
  assert.equal(assembled.length, V2.length);
  assert.ok(assembled.equals(V2));
  assert.equal(sha(assembled), sha(V2));
});

test('并发竞争：同一前置版本的两个切换仅一个成功，其余 409', async () => {
  await publish('10.2.0', 'WT-ACTIVE', Buffer.from('v1020-'.repeat(50)));
  await publish('10.3.0', 'WT-ACTIVE', Buffer.from('v1030-'.repeat(50)));
  const results = await Promise.all([
    switchActive('WT-ACTIVE', { releaseVersion: '10.2.0', expectedVersion: '10.1.0' }),
    switchActive('WT-ACTIVE', { releaseVersion: '10.3.0', expectedVersion: '10.1.0' }),
  ]);
  const statuses = results.map((r) => r.status).sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);
  const bodies = await Promise.all(results.map((r) => r.json().catch(() => ({}))));
  const winner = bodies.find((b) => b.activeVersion).activeVersion;
  assert.ok(['10.2.0', '10.3.0'].includes(winner));

  // 设备随后取得的只能是赢家版本的完整发布件
  const got = await fetch(stableUrl('WT-ACTIVE'));
  assert.equal(got.status, 200);
  const buf = Buffer.from(await got.arrayBuffer());
  const expectBuf = winner === '10.2.0'
    ? Buffer.from('v1020-'.repeat(50))
    : Buffer.from('v1030-'.repeat(50));
  assert.ok(buf.equals(expectBuf));
  assert.equal(got.headers.get('etag'), `"${sha(expectBuf)}"`);
});

test('切换不影响原发布、清单与按版本下载', async () => {
  // 旧版本按版本地址仍可取到原始不可变字节
  const old = await fetch(`${base}/api/firmware/releases/10.0.0/artifact`);
  assert.equal(old.status, 200);
  assert.ok(Buffer.from(await old.arrayBuffer()).equals(V1));

  const list = await fetch(`${base}/api/firmware/releases`).then((r) => r.json());
  for (const v of ['10.0.0', '10.1.0', '10.2.0', '10.3.0', '20.0.0']) {
    assert.ok(list.releases.some((x) => x.version === v), `清单仍含 ${v}`);
  }
});

test('请求体非法时明确 4xx', async () => {
  const cases = [
    { body: 'not-json', status: 400, code: 'INVALID_JSON_BODY' },
    { body: JSON.stringify({ releaseVersion: '10.0.0' }), status: 400, code: 'INVALID_EXPECTED_VERSION' },
    { body: JSON.stringify({ expectedVersion: null }), status: 400, code: 'INVALID_VERSION' },
    { body: JSON.stringify({ releaseVersion: '10.0.0', expectedVersion: 123 }), status: 400, code: 'INVALID_EXPECTED_VERSION' },
    { body: JSON.stringify({ releaseVersion: 'bad/ver', expectedVersion: null }), status: 400, code: 'INVALID_VERSION' },
  ];
  for (const c of cases) {
    const r = await fetch(switchUrl('WT-ACTIVE'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: c.body,
    });
    assert.equal(r.status, c.status, `${c.body} → ${c.status}`);
    assert.equal((await r.json()).error.code, c.code);
  }
});

test('非 ASCII 型号经稳定路由可切换与下载（映射文件名与型号解耦）', async () => {
  const data = Buffer.from('unicode-model-风机-'.repeat(88));
  await publish('30.0.0', 'WT-海上', data);
  const sw = await switchActive('WT-海上', { releaseVersion: '30.0.0', expectedVersion: null });
  assert.equal(sw.status, 200, await sw.text());
  const got = await fetch(stableUrl('WT-海上'));
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('etag'), `"${sha(data)}"`);
  assert.ok(Buffer.from(await got.arrayBuffer()).equals(data));
});

test('活动映射经重启保持：新实例稳定地址仍下载最后成功切换的版本', async () => {
  const winnerCandidates = {
    '10.2.0': Buffer.from('v1020-'.repeat(50)),
    '10.3.0': Buffer.from('v1030-'.repeat(50)),
  };
  const s2 = createServer({ dataDir: root, maxUploadBytes: 8 * 1024 * 1024 });
  await s2.waitForReady();
  await new Promise((resolve) => s2.listen(0, '127.0.0.1', resolve));
  try {
    const p2 = `http://127.0.0.1:${s2.address().port}`;
    const url = `${p2}/api/firmware/models/${encodeURIComponent('WT-ACTIVE')}/artifact`;
    const r = await fetch(url);
    assert.equal(r.status, 200);
    const buf = Buffer.from(await r.arrayBuffer());
    const etag = r.headers.get('etag');
    const match = Object.entries(winnerCandidates).find(([, d]) => `"${sha(d)}"` === etag);
    assert.ok(match, `重启后 ETag ${etag} 应对应最后一次成功切换的赢家版本`);
    assert.ok(buf.equals(match[1]));
    // Range 语义在重启后同样可用，且仍属同一版本
    const part = await fetch(url, { headers: { Range: 'bytes=0-99' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('etag'), etag);
    assert.ok(Buffer.from(await part.arrayBuffer()).equals(match[1].subarray(0, 100)));
  } finally {
    await new Promise((resolve) => s2.close(resolve));
  }
});

test('响应进行中切换活动版本：进行中的下载不得拼接新旧版本', async () => {
  // 准备：同一型号两个版本，先激活 slowOld，再发起一个慢速 Range 下载，
  // 连接暂停期间切换到 slowNew，恢复读取后整段字节仍必须全部属于 slowOld。
  const model = 'WT-INFLIGHT';
  const oldBuf = Buffer.alloc(5_000_000, 0x61); // 'a'
  const newBuf = Buffer.alloc(5_000_000, 0x62); // 'b'
  await publish('50.0.0', model, oldBuf);
  await publish('50.1.0', model, newBuf);

  const first = await switchActive(model, { releaseVersion: '50.0.0', expectedVersion: null });
  assert.equal(first.status, 200);

  // 原始 TCP：在 data 事件内读到响应头后立即同步 pause，
  // 使 5MB body 滞留在传输中（背压），服务端流停在响应中段
  const port = server.address().port;
  const sock = net.createConnection({ host: '127.0.0.1', port });
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  sock.setNoDelay();
  sock.write(
    `GET /api/firmware/models/${encodeURIComponent(model)}/artifact HTTP/1.1\r\n`
    + `Host: 127.0.0.1\r\nRange: bytes=0-4999999\r\n\r\n`,
  );

  const head = await new Promise((resolve, reject) => {
    const chunks = [];
    const onData = (c) => {
      chunks.push(c);
      const all = Buffer.concat(chunks);
      const idx = all.indexOf('\r\n\r\n');
      if (idx !== -1) {
        sock.pause(); // 同步暂停：后续 body 字节不再投递
        sock.removeListener('data', onData);
        resolve({ raw: all, headerEnd: idx + 4 });
      }
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
  const headerText = head.raw.subarray(0, head.headerEnd - 4).toString('latin1');
  assert.match(headerText, /^HTTP\/1.1 206/);
  const etagM = headerText.match(/ETag: "([a-f0-9]{64})"/i);
  assert.ok(etagM);
  assert.equal(etagM[1], sha(oldBuf));

  // 在响应进行中切换活动版本
  const sw = await switchActive(model, { releaseVersion: '50.1.0', expectedVersion: '50.0.0' });
  assert.equal(sw.status, 200);
  // 新请求立即看到新版本
  const after = await fetch(stableUrl(model));
  assert.equal(after.headers.get('etag'), `"${sha(newBuf)}"`);
  await after.arrayBuffer();

  // 恢复旧连接，收集剩余字节（含已到达头部缓冲的 body 前缀）
  const bodyParts = [head.raw.subarray(head.headerEnd)];
  const rest = await new Promise((resolve, reject) => {
    sock.on('data', (c) => bodyParts.push(c));
    sock.on('end', resolve);
    sock.on('error', reject);
    sock.resume();
  });
  void rest;
  const body = Buffer.concat(bodyParts);
  assert.equal(body.length, 5_000_000);
  // 每一字节都必须属于旧版本：不含任何新版本字节，且与旧版本摘要一致
  assert.ok(body.equals(oldBuf), '进行中的响应拼接了新版本字节');
  assert.equal(sha(body), sha(oldBuf));
  sock.destroy();
});
