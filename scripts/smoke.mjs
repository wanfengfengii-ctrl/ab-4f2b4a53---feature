// 发布后分段重组 API 冒烟测试：对运行中的服务执行真实 HTTP 调用。
// 覆盖：健康等待 → 发布 → 重复版本 409 → 摘要错误 422 → 全量/HEAD →
// 闭区间/开放尾端/后缀 206 分段重组字节一致 → 416 → If-Range 不符回退 200。
import { createHash } from 'node:crypto';

const BASE = process.env.APP_URL || `http://127.0.0.1:${process.env.PORT || '8080'}`;
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitHealthy(deadlineMs = 30_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch { /* 尚未起来 */ }
    if (Date.now() > deadline) throw new Error(`服务在 ${deadlineMs}ms 内未通过健康检查：${BASE}/healthz`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function publishRaw(version, data, hash) {
  const fd = new FormData();
  fd.set('version', version);
  fd.set('targetModel', 'WT-SMOKE');
  fd.set('sha256', hash);
  fd.set('artifact', new Blob([data], { type: 'application/octet-stream' }), `${version}.bin`);
  return fetch(`${BASE}/api/firmware/releases`, { method: 'POST', body: fd });
}

async function main() {
  console.log(`[smoke] 目标服务：${BASE}`);
  await waitHealthy();
  console.log('[smoke] 服务健康，开始冒烟');

  // 1) 正常发布：约 300KB 伪随机内容
  const size = 300_000 + 7;
  const data = Buffer.alloc(size);
  for (let i = 0; i < size; i++) data[i] = (i * 31 + (i >>> 8)) & 0xff;
  const version = `smoke-${stamp}`;
  const digest = sha256(data);

  const created = await publishRaw(version, data, digest);
  check('发布返回 201', created.status === 201, `got ${created.status} ${await created.text()}`);
  check('发布响应 ETag 为摘要', created.headers.get('etag') === `"${digest}"`);

  // 2) 重复版本 → 409，且原字节不变
  const dup = await publishRaw(version, Buffer.from('tampered'), sha256(Buffer.from('tampered')));
  check('重复版本返回 409', dup.status === 409, `got ${dup.status}`);

  // 3) 摘要错误 → 422，且未污染发布区
  const badVer = `smoke-bad-${stamp}`;
  const bad = await publishRaw(badVer, data, '0'.repeat(64));
  check('摘要不符返回 422', bad.status === 422, `got ${bad.status}`);
  const badGet = await fetch(`${BASE}/api/firmware/releases/${badVer}/artifact`);
  check('摘要错误的版本不可下载（未污染）', badGet.status === 404, `got ${badGet.status}`);

  const url = `${BASE}/api/firmware/releases/${version}/artifact`;

  // 4) 全量 GET 200：状态头、ETag、Content-Length、实际字节/摘要
  const full = await fetch(url);
  const fullBuf = Buffer.from(await full.arrayBuffer());
  check('全量下载返回 200', full.status === 200);
  check('Accept-Ranges: bytes', full.headers.get('accept-ranges') === 'bytes');
  check('全量 Content-Length 一致', Number(full.headers.get('content-length')) === size);
  check('全量 ETag 一致', full.headers.get('etag') === `"${digest}"`);
  check('全量字节摘要与发布件一致', sha256(fullBuf) === digest);

  // 5) HEAD 头与 GET 一致且无响应体
  const head = await fetch(url, { method: 'HEAD' });
  check('HEAD 返回 200 且 Content-Length 一致',
    head.status === 200 && Number(head.headers.get('content-length')) === size);
  check('HEAD 响应体为空', (await head.text()) === '');

  // 6) 分段下载（三种 Range 形态混用）并按序重组
  const ranges = [
    { header: 'bytes=0-99', from: 0, to: 99 },          // 闭区间
    { header: 'bytes=100-100', from: 100, to: 100 },    // 单字节
    { header: 'bytes=101-199999', from: 101, to: 199999 },
    { header: `bytes=200000-`, from: 200000, to: size - 1 }, // 开放尾端
  ];
  const parts = [];
  for (const r of ranges) {
    const resp = await fetch(url, { headers: { Range: r.header } });
    const buf = Buffer.from(await resp.arrayBuffer());
    const expectCR = `bytes ${r.from}-${r.to}/${size}`;
    check(`${r.header} → 206`, resp.status === 206, `got ${resp.status}`);
    check(`${r.header} Content-Range 一致`, resp.headers.get('content-range') === expectCR,
      `got ${resp.headers.get('content-range')}`);
    check(`${r.header} Content-Length 一致`,
      Number(resp.headers.get('content-length')) === r.to - r.from + 1);
    check(`${r.header} 字节内容一致`, buf.equals(data.subarray(r.from, r.to + 1)));
    parts.push(buf);
  }
  const assembled = Buffer.concat(parts);
  check('分段重组长度等于发布件', assembled.length === size, `${assembled.length} != ${size}`);
  check('分段重组摘要与发布件完全一致', sha256(assembled) === digest);

  // 7) 后缀 Range
  const suffixLen = 50_000;
  const suf = await fetch(url, { headers: { Range: `bytes=-${suffixLen}` } });
  const sufBuf = Buffer.from(await suf.arrayBuffer());
  check('后缀 Range → 206', suf.status === 206, `got ${suf.status}`);
  check('后缀 Content-Range 一致',
    suf.headers.get('content-range') === `bytes ${size - suffixLen}-${size - 1}/${size}`);
  check('后缀字节内容一致', sufBuf.equals(data.subarray(size - suffixLen)));

  // 8) 非法范围 → 416 且 Content-Range: bytes */size
  const unsat = await fetch(url, { headers: { Range: `bytes=${size}-` } });
  check('越界起点返回 416', unsat.status === 416, `got ${unsat.status}`);
  check('416 带 Content-Range: bytes */size',
    unsat.headers.get('content-range') === `bytes */${size}`,
    `got ${unsat.headers.get('content-range')}`);
  await unsat.arrayBuffer().catch(() => {});

  // 9) If-Range 与当前 ETag 不符 → 返回完整文件 200
  const stale = await fetch(url, {
    headers: { Range: 'bytes=0-99', 'If-Range': '"stale"' },
  });
  const staleBuf = Buffer.from(await stale.arrayBuffer());
  check('If-Range 不符返回 200 完整文件',
    stale.status === 200 && staleBuf.length === size,
    `status=${stale.status} len=${staleBuf.length}`);
  check('If-Range 不符时字节为完整发布件', sha256(staleBuf) === digest);

  // 10) If-Range 与当前 ETag 相符 → 206
  const fresh = await fetch(url, {
    headers: { Range: 'bytes=0-99', 'If-Range': `"${digest}"` },
  });
  check('If-Range 相符返回 206', fresh.status === 206, `got ${fresh.status}`);

  // 11) 发布清单包含新版本
  const list = await fetch(`${BASE}/api/firmware/releases`).then((r) => r.json());
  check('发布清单含本次版本', Array.isArray(list.releases)
    && list.releases.some((x) => x.version === version && x.sha256 === digest));

  console.log(failures === 0
    ? `[smoke] 全部通过 ✅ (${BASE})`
    : `[smoke] ${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[smoke] 异常中断:', err);
  process.exit(1);
});
