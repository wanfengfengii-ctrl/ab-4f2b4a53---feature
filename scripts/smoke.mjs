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

async function publishRaw(version, data, hash, targetModel = 'WT-SMOKE') {
  const fd = new FormData();
  fd.set('version', version);
  fd.set('targetModel', targetModel);
  fd.set('sha256', hash);
  fd.set('artifact', new Blob([data], { type: 'application/octet-stream' }), `${version}.bin`);
  return fetch(`${BASE}/api/firmware/releases`, { method: 'POST', body: fd });
}
const publishRawFor = publishRaw;

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

  // ================= 型号活动固件切换（稳定地址取件） =================
  const model = `WT-SMOKE-ACTIVE-${stamp}`;
  const otherModel = `WT-SMOKE-OTHER-${stamp}`;
  const switchUrl = (m) => `${BASE}/api/firmware/models/${encodeURIComponent(m)}/active`;
  const stableUrl = (m) => `${BASE}/api/firmware/models/${encodeURIComponent(m)}/artifact`;
  const switchRaw = (m, body) => fetch(switchUrl(m), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const mkBuf = (tag, n = 150_000) => {
    // 固定长度的可区分内容：不同 tag 字节不同，长度确定以便固定分段
    let seed = tag.length;
    for (let i = 0; i < tag.length; i++) seed = (seed * 31 + tag.charCodeAt(i)) & 0xffff;
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = (i * 17 + seed + (i >>> 9)) & 0xff;
    return b;
  };
  const vA = `act-a-${stamp}`;
  const vB = `act-b-${stamp}`;
  const vC = `act-c-${stamp}`;
  const vD = `act-d-${stamp}`;
  const vOther = `act-other-${stamp}`;
  const bufA = mkBuf(vA);
  const bufB = mkBuf(vB);
  const bufC = mkBuf(vC);
  const bufD = mkBuf(vD);
  const bufOther = mkBuf(vOther);
  for (const [v, b, m] of [
    [vA, bufA, model], [vB, bufB, model], [vC, bufC, model], [vD, bufD, model],
    [vOther, bufOther, otherModel],
  ]) {
    const r = await publishRawFor(v, b, sha256(b), m);
    check(`发布 ${v}`, r.status === 201, `got ${r.status} ${await r.text()}`);
  }

  // 切换前稳定地址 404
  const pre = await fetch(stableUrl(model));
  check('切换前稳定地址返回 404', pre.status === 404, `got ${pre.status}`);

  // 首次切换 expectedVersion 非 null → 409
  const firstBad = await switchRaw(model, { releaseVersion: vA, expectedVersion: '0.0.0' });
  check('首切误传前置版本返回 409', firstBad.status === 409, `got ${firstBad.status}`);
  check('首切失败错误码 VERSION_CONFLICT', (await firstBad.json()).error.code === 'VERSION_CONFLICT');

  // 未知发布版本 → 404
  const unknown = await switchRaw(model, { releaseVersion: 'no-such-version', expectedVersion: null });
  check('未知发布版本返回 404', unknown.status === 404, `got ${unknown.status}`);
  check('未知发布错误码 RELEASE_NOT_FOUND', (await unknown.json()).error.code === 'RELEASE_NOT_FOUND');

  // 型号不符 → 409
  const mismatch = await switchRaw(model, { releaseVersion: vOther, expectedVersion: null });
  check('型号不符返回 409', mismatch.status === 409, `got ${mismatch.status}`);
  check('型号不符错误码 MODEL_MISMATCH', (await mismatch.json()).error.code === 'MODEL_MISMATCH');

  // 首次切换成功：返回活动版本与 ETag
  const swA = await switchRaw(model, { releaseVersion: vA, expectedVersion: null });
  check('首次切换成功返回 200', swA.status === 200, `got ${swA.status}`);
  const swABody = await swA.json();
  check('切换响应活动版本正确', swABody.activeVersion === vA);
  check('切换响应 ETag 与发布件一致', swA.headers.get('etag') === `"${sha256(bufA)}"`);

  // 稳定地址取件：全量/HEAD/206/416/If-Range
  const sUrl = stableUrl(model);
  const fullA = await fetch(sUrl);
  const fullABuf = Buffer.from(await fullA.arrayBuffer());
  check('稳定地址全量 200 且字节属于活动版本',
    fullA.status === 200 && fullABuf.equals(bufA)
    && fullA.headers.get('etag') === `"${sha256(bufA)}"`);

  const headA = await fetch(sUrl, { method: 'HEAD' });
  check('稳定地址 HEAD 与 GET 头一致无响应体',
    headA.status === 200
    && Number(headA.headers.get('content-length')) === bufA.length
    && headA.headers.get('etag') === `"${sha256(bufA)}"`
    && (await headA.text()) === '');

  const partA = await fetch(sUrl, { headers: { Range: 'bytes=100-199', 'If-Range': `"${sha256(bufA)}"` } });
  check('稳定地址 206 且字节/ETag 同属活动版本',
    partA.status === 206
    && partA.headers.get('content-range') === `bytes 100-199/${bufA.length}`
    && partA.headers.get('etag') === `"${sha256(bufA)}"`
    && Buffer.from(await partA.arrayBuffer()).equals(bufA.subarray(100, 200)));

  const unsatA = await fetch(sUrl, { headers: { Range: `bytes=${bufA.length}-` } });
  check('稳定地址越界 Range 返回 416',
    unsatA.status === 416
    && unsatA.headers.get('content-range') === `bytes */${bufA.length}`,
    `got ${unsatA.status}`);
  await unsatA.arrayBuffer().catch(() => {});

  const staleIfRange = await fetch(sUrl, {
    headers: { Range: 'bytes=0-99', 'If-Range': '"stale"' },
  });
  check('稳定地址 If-Range 不符回退完整 200',
    staleIfRange.status === 200
    && Number(staleIfRange.headers.get('content-length')) === bufA.length
    && sha256(Buffer.from(await staleIfRange.arrayBuffer())) === sha256(bufA));

  // 前置版本过期 → 409，活动版本不变
  const staleExp = await switchRaw(model, { releaseVersion: vB, expectedVersion: '0.0.0' });
  check('前置版本过期返回 409', staleExp.status === 409, `got ${staleExp.status}`);
  const unchanged = await fetch(sUrl);
  check('失败切换不改变活动版本',
    unchanged.headers.get('etag') === `"${sha256(bufA)}"`,
    `got ${unchanged.headers.get('etag')}`);
  await unchanged.arrayBuffer().catch(() => {});

  // 正常切换 A → B
  const swB = await switchRaw(model, { releaseVersion: vB, expectedVersion: vA });
  check('按正确前置版本切换成功', swB.status === 200, `got ${swB.status}`);
  check('切换响应新版本与 ETag',
    (await swB.json()).activeVersion === vB
    && swB.headers.get('etag') === `"${sha256(bufB)}"`);
  const fullB = await fetch(sUrl);
  const fullBBuf = Buffer.from(await fullB.arrayBuffer());
  check('切换后稳定地址只下发新活动版本完整发布件',
    fullB.status === 200 && fullBBuf.equals(bufB)
    && fullB.headers.get('etag') === `"${sha256(bufB)}"`);
  // 分段重组仍是完整新版本（头与字节同版）
  const segRanges = ['bytes=0-49999', 'bytes=50000-99999', 'bytes=100000-'];
  const segParts = [];
  for (const rh of segRanges) {
    const rr = await fetch(sUrl, { headers: { Range: rh, 'If-Range': `"${sha256(bufB)}"` } });
    if (rr.status !== 206) { check(`${rh} → 206`, false, `got ${rr.status}`); }
    segParts.push(Buffer.from(await rr.arrayBuffer()));
  }
  const segAssembled = Buffer.concat(segParts);
  check('切换后分段重组为完整新发布件',
    segAssembled.length === bufB.length && segAssembled.equals(bufB)
    && sha256(segAssembled) === sha256(bufB));

  // 并发竞争：同一前置版本 vB，两个目标版本只能一个成功
  const race = await Promise.all([
    switchRaw(model, { releaseVersion: vC, expectedVersion: vB }),
    switchRaw(model, { releaseVersion: vD, expectedVersion: vB }),
  ]);
  const raceStatus = race.map((r) => r.status).sort((a, b) => a - b);
  check('并发切换仅一个成功（200/409）',
    raceStatus[0] === 200 && raceStatus[1] === 409,
    `got ${raceStatus.join(',')}`);
  const raceBodies = await Promise.all(race.map((r) => r.json().catch(() => ({}))));
  const winner = raceBodies.find((x) => x.activeVersion)?.activeVersion;
  const winnerBuf = winner === vC ? bufC : bufD;
  check('并发赢家为 C/D 之一', winner === vC || winner === vD, `winner=${winner}`);
  const afterRace = await fetch(sUrl);
  const afterRaceBuf = Buffer.from(await afterRace.arrayBuffer());
  check('竞争后设备仅取得赢家版本的完整发布件',
    afterRace.status === 200 && afterRaceBuf.equals(winnerBuf)
    && afterRace.headers.get('etag') === `"${sha256(winnerBuf)}"`);

  // 原发布、清单、按版本下载不受切换影响
  const oldByVersion = await fetch(`${BASE}/api/firmware/releases/${vA}/artifact`);
  check('旧版本按版本地址仍可下载原始字节',
    oldByVersion.status === 200
    && Buffer.from(await oldByVersion.arrayBuffer()).equals(bufA));
  const list2 = await fetch(`${BASE}/api/firmware/releases`).then((r) => r.json());
  check('清单仍包含全部已发布版本', [vA, vB, vC, vD, vOther]
    .every((v) => list2.releases.some((x) => x.version === v)));

  console.log(failures === 0
    ? `[smoke] 全部通过 ✅ (${BASE})`
    : `[smoke] ${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[smoke] 异常中断:', err);
  process.exit(1);
});
