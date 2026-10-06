// 发布后分段重组 API 冒烟测试：对运行中的服务执行真实 HTTP 调用。
// 覆盖：健康等待 → 发布 → 重复版本 409 → 摘要错误 422 → 全量/HEAD →
// 闭区间/开放尾端/后缀 206 分段重组字节一致 → 416 → If-Range 不符回退 200 →
// 活动固件切换（前置版本 CAS、并发唯一成功、设备稳定地址取件、重启前最后一次切换生效）。
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

const switchActive = (model, releaseVersion, expectedVersion) =>
  fetch(`${BASE}/api/firmware/models/${encodeURIComponent(model)}/active`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ releaseVersion, expectedVersion }),
  });

const modelArtifact = (model) =>
  `${BASE}/api/firmware/models/${encodeURIComponent(model)}/artifact`;

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

  // ============ 活动固件切换（本轮业务验收） ============
  const model = `WT-ACT-${stamp}`;
  const mkData = (seed, n) => {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = (i * 17 + seed + (i >>> 7)) & 0xff;
    return b;
  };
  const actV1 = `act-1-${stamp}`;
  const actV2 = `act-2-${stamp}`;
  const actData1 = mkData(3, 120_000);
  const actData2 = mkData(9, 150_000);
  const actSha1 = sha256(actData1);
  const actSha2 = sha256(actData2);
  check('活动版本 v1 发布成功',
    (await publishRaw(actV1, actData1, actSha1, model)).status === 201);
  check('活动版本 v2 发布成功',
    (await publishRaw(actV2, actData2, actSha2, model)).status === 201);

  // 12) 未设置活动固件：设备取件 404
  const noActive = await fetch(modelArtifact(model));
  check('未切换前设备取件返回 404', noActive.status === 404, `got ${noActive.status}`);
  await noActive.arrayBuffer().catch(() => {});

  // 13) 首次切换前置版本非 null → 409，且活动版本仍不存在
  const firstBad = await switchActive(model, actV1, '0.0.0-stale');
  check('首次切换 expectedVersion 非 null 返回 409', firstBad.status === 409,
    `got ${firstBad.status}`);
  check('首次切换失败后设备仍 404',
    (await fetch(modelArtifact(model))).status === 404);

  // 14) 未知发布 / 型号不符 → 明确报错
  const unknownRel = await switchActive(model, `missing-${stamp}`, null);
  check('切换未知发布返回 404', unknownRel.status === 404, `got ${unknownRel.status}`);
  const otherModelVer = `act-other-${stamp}`;
  check('异型号发布件发布成功', (await publishRaw(
    otherModelVer, actData1, actSha1, `WT-OTHER-${stamp}`)).status === 201);
  const mismatch = await switchActive(model, otherModelVer, null);
  check('型号不符返回 409 MODEL_MISMATCH', mismatch.status === 409
    && (await mismatch.json()).error.code === 'MODEL_MISMATCH',
    `got ${mismatch.status}`);

  // 15) 首次切换 expectedVersion=null → 200，返回活动版本与 ETag
  const sw1 = await switchActive(model, actV1, null);
  const sw1Body = await sw1.json().catch(() => null);
  check('首次切换成功返回 200', sw1.status === 200,
    `got ${sw1.status} ${JSON.stringify(sw1Body)}`);
  check('切换响应 ETag 为活动发布件摘要', sw1.headers.get('etag') === `"${actSha1}"`);
  check('切换响应含活动版本', !!sw1Body && sw1Body.activeVersion === actV1
    && sw1Body.previousVersion === null && sw1Body.targetModel === model);

  // 16) 设备从稳定地址取得活动发布件：全量 + HEAD + 分段重组
  const devFull = await fetch(modelArtifact(model));
  const devFullBuf = Buffer.from(await devFull.arrayBuffer());
  check('设备全量取件 200 且字节与 v1 一致',
    devFull.status === 200 && sha256(devFullBuf) === actSha1);
  check('设备端 ETag 与切换响应一致', devFull.headers.get('etag') === `"${actSha1}"`);
  const devHead = await fetch(modelArtifact(model), { method: 'HEAD' });
  check('设备端 HEAD 一致', devHead.status === 200
    && Number(devHead.headers.get('content-length')) === actData1.length
    && (await devHead.text()) === '');
  const devParts = [];
  for (const h of ['bytes=0-49999', 'bytes=50000-']) {
    const pr = await fetch(modelArtifact(model), { headers: { Range: h } });
    devParts.push(Buffer.from(await pr.arrayBuffer()));
    check(`设备端 ${h} → 206`, pr.status === 206, `got ${pr.status}`);
  }
  check('设备端分段重组与 v1 完全一致', sha256(Buffer.concat(devParts)) === actSha1);
  const devUnsat = await fetch(modelArtifact(model),
    { headers: { Range: `bytes=${actData1.length}-` } });
  check('设备端越界 Range → 416', devUnsat.status === 416
    && devUnsat.headers.get('content-range') === `bytes */${actData1.length}`);
  await devUnsat.arrayBuffer().catch(() => {});

  // 17) expectedVersion 过期 → 409，活动版本不变
  const staleSw = await switchActive(model, actV2, '0.0.0-stale');
  check('前置版本过期返回 409', staleSw.status === 409
    && (await staleSw.json()).error.code === 'VERSION_CONFLICT', `got ${staleSw.status}`);
  const stillV1 = Buffer.from(await (await fetch(modelArtifact(model))).arrayBuffer());
  check('409 后设备仍取得 v1 完整发布件', sha256(stillV1) === actSha1);

  // 18) 前置版本匹配 → 切换 v2 成功；If-Range 旧摘要回退完整 200
  const sw2 = await switchActive(model, actV2, actV1);
  check('前置版本匹配切换 v2 成功', sw2.status === 200, `got ${sw2.status}`);
  check('切换响应 previousVersion 正确', (await sw2.json()).previousVersion === actV1);
  const devV2 = Buffer.from(await (await fetch(modelArtifact(model))).arrayBuffer());
  check('设备随后取得 v2 完整发布件', sha256(devV2) === actSha2);
  const ifRangeOld = await fetch(modelArtifact(model), {
    headers: { Range: 'bytes=0-99', 'If-Range': `"${actSha1}"` },
  });
  const ifRangeOldBuf = Buffer.from(await ifRangeOld.arrayBuffer());
  check('If-Range 为旧版本摘要时回退完整 200（不拼接新旧版本）',
    ifRangeOld.status === 200 && sha256(ifRangeOldBuf) === actSha2);
  const ifRangeNew = await fetch(modelArtifact(model), {
    headers: { Range: 'bytes=0-99', 'If-Range': `"${actSha2}"` },
  });
  check('If-Range 为当前摘要时返回 206', ifRangeNew.status === 206);
  await ifRangeNew.arrayBuffer();

  // 19) 并发切换：同一前置版本下只有一个成功
  const raceV3 = `act-3-${stamp}`;
  const raceV4 = `act-4-${stamp}`;
  const raceData3 = mkData(21, 80_000);
  const raceData4 = mkData(33, 90_000);
  await publishRaw(raceV3, raceData3, sha256(raceData3), model);
  await publishRaw(raceV4, raceData4, sha256(raceData4), model);
  const raceResults = await Promise.all([
    ...Array.from({ length: 3 }, () => switchActive(model, raceV3, actV2)),
    ...Array.from({ length: 3 }, () => switchActive(model, raceV4, actV2)),
  ]);
  const raceOks = raceResults.filter((r) => r.status === 200);
  check('并发切换只有一个成功，其余 409', raceOks.length === 1
    && raceResults.every((r) => r.status === 200 || r.status === 409),
    `200×${raceOks.length} / ${raceResults.map((r) => r.status).join(',')}`);
  const winnerVersion = (await raceOks[0].json()).activeVersion;
  const winnerData = winnerVersion === raceV3 ? raceData3 : raceData4;
  const afterRace = Buffer.from(await (await fetch(modelArtifact(model))).arrayBuffer());
  check('并发后设备取得最后一次成功切换的完整发布件',
    sha256(afterRace) === sha256(winnerData));

  // 20) 按版本下载不受切换影响
  const byVer = Buffer.from(await (await fetch(
    `${BASE}/api/firmware/releases/${actV1}/artifact`)).arrayBuffer());
  check('按版本下载 v1 字节不变', sha256(byVer) === actSha1);

  console.log(failures === 0
    ? `[smoke] 全部通过 ✅ (${BASE})`
    : `[smoke] ${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[smoke] 异常中断:', err);
  process.exit(1);
});
