// HTTP 服务：固件发布（multipart，SHA-256 校验，原子发布）与分段续传下载。
// 零运行时依赖，仅使用 Node.js 内置模块。
import http from 'node:http';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { parseMultipart, MultipartError } from './multipart.js';
import { FirmwareStore, StoreError, VERSION_RE } from './store.js';
import { resolveRange, ifRangeMatches } from './range.js';

const ROUTES = {
  releases: '/api/firmware/releases',
};

export function createServer({ dataDir, maxUploadBytes }) {
  const store = new FirmwareStore(dataDir);
  const tmpDir = path.join(dataDir, 'tmp');

  const sendJson = (res, status, payload, extraHeaders = {}) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      ...extraHeaders,
    });
    res.end(body);
  };

  const sendError = (res, status, code, message, extraHeaders = {}) => {
    sendJson(res, status, { error: { code, message } }, extraHeaders);
  };

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    try {
      if (req.method === 'GET' && (p === '/healthz' || p === '/health')) {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      if (p === ROUTES.releases) {
        if (req.method === 'GET') {
          sendJson(res, 200, { releases: store.list() });
          return;
        }
        if (req.method === 'POST') {
          await handlePublish(req, res);
          return;
        }
        res.setHeader('Allow', 'GET, POST');
        sendError(res, 405, 'METHOD_NOT_ALLOWED', `不支持的方法 ${req.method}`);
        return;
      }

      const artifactM = /^\/api\/firmware\/releases\/([^/]+)\/artifact\/?$/.exec(p);
      if (artifactM) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          let version;
          try {
            version = decodeURIComponent(artifactM[1]);
          } catch {
            sendError(res, 400, 'BAD_REQUEST', '版本号编码非法');
            return;
          }
          await handleReleaseArtifact(req, res, version);
          return;
        }
        res.setHeader('Allow', 'GET, HEAD');
        sendError(res, 405, 'METHOD_NOT_ALLOWED', `不支持的方法 ${req.method}`);
        return;
      }

      // 型号维度：切换活动固件 POST .../active，设备稳定地址下载 GET|HEAD .../artifact
      const modelM = /^\/api\/firmware\/models\/([^/]+)\/(active|artifact)\/?$/.exec(p);
      if (modelM) {
        let targetModel;
        try {
          targetModel = decodeURIComponent(modelM[1]);
        } catch {
          sendError(res, 400, 'BAD_REQUEST', '型号编码非法');
          return;
        }
        if (modelM[2] === 'active') {
          if (req.method === 'POST') {
            await handleSetActive(req, res, targetModel);
          } else {
            res.setHeader('Allow', 'POST');
            sendError(res, 405, 'METHOD_NOT_ALLOWED', `不支持的方法 ${req.method}`);
          }
          return;
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          await handleActiveArtifact(req, res, targetModel);
          return;
        }
        res.setHeader('Allow', 'GET, HEAD');
        sendError(res, 405, 'METHOD_NOT_ALLOWED', `不支持的方法 ${req.method}`);
        return;
      }

      sendError(res, 404, 'NOT_FOUND', `未知路径 ${p}`);
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = err.status || 500;
      sendError(res, status, err.code || 'INTERNAL_ERROR', err.message || '内部错误');
      // 确保上传连接被排空/终止
      if (!req.complete) req.destroy();
    }
  };

  async function handlePublish(req, res) {
    const ct = req.headers['content-type'] || '';
    if (!ct.toLowerCase().startsWith('multipart/form-data')) {
      sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', '发布请求必须使用 multipart/form-data');
      drain(req);
      return;
    }
    const declaredLen = Number.parseInt(req.headers['content-length'] || '', 10);
    if (Number.isFinite(declaredLen) && declaredLen > maxUploadBytes) {
      sendError(res, 413, 'PAYLOAD_TOO_LARGE',
        `上传体积 ${declaredLen} 超过上限 ${maxUploadBytes}`);
      drain(req);
      return;
    }

    let parsed;
    try {
      parsed = await parseMultipart(req, { tmpDir, maxFileSize: maxUploadBytes });
    } catch (err) {
      const status = err instanceof MultipartError ? err.status : 400;
      sendError(res, status, err.code || 'MULTIPART_ERROR', err.message);
      return;
    }

    const { fields, files, cleanup } = parsed;
    try {
      const file = files.artifact;
      const meta = await store.publish({ fields, file });
      sendJson(res, 201, meta, {
        Location: `${ROUTES.releases}/${encodeURIComponent(meta.version)}/artifact`,
        ETag: etagOf(meta),
      });
    } catch (err) {
      if (err instanceof StoreError) {
        sendError(res, err.status, err.code, err.message);
      } else {
        sendError(res, 500, 'INTERNAL_ERROR', `发布失败: ${err.message}`);
      }
    } finally {
      // publish 成功时临时文件已被 rename 走；失败时 store 已清理；此处兜底
      await cleanup().catch(() => {});
    }
  }

  async function handleReleaseArtifact(req, res, version) {
    const meta = store.get(version);
    if (!meta || !VERSION_RE.test(version)) {
      sendError(res, 404, 'RELEASE_NOT_FOUND', `版本 ${version} 不存在`);
      return;
    }
    await serveArtifact(req, res, meta);
  }

  async function handleActiveArtifact(req, res, targetModel) {
    // 仅解析一次不可变发布件元数据：整个响应（头与字节）都锁定在该版本，
    // 即便响应期间活动版本被切换，设备拿到的仍是最后一次成功切换时的完整发布件。
    const meta = store.getActiveMeta(targetModel);
    if (!meta) {
      sendError(res, 404, 'ACTIVE_RELEASE_NOT_FOUND',
        `型号 ${targetModel} 尚无活动固件`);
      return;
    }
    await serveArtifact(req, res, meta);
  }

  async function handleSetActive(req, res, targetModel) {
    if (!targetModel || targetModel.length > 128) {
      sendError(res, 400, 'INVALID_TARGET_MODEL', 'targetModel 缺失或过长（最长 128）');
      drain(req);
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(req, 64 * 1024);
    } catch (err) {
      sendError(res, err.status || 400, err.code || 'BAD_REQUEST', err.message);
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      sendError(res, 400, 'INVALID_JSON_BODY', '请求体必须是 JSON 对象');
      return;
    }

    const { releaseVersion, expectedVersion } = payload;
    if (typeof releaseVersion !== 'string' || !VERSION_RE.test(releaseVersion.trim())) {
      sendError(res, 400, 'INVALID_VERSION',
        'releaseVersion 缺失或非法（允许 1-64 位字母数字与 ._+-，且首字符为字母数字）');
      return;
    }
    // expectedVersion 必须显式给出：字符串版本号，或 null（首次切换必须为 null）
    if (!('expectedVersion' in payload)) {
      sendError(res, 400, 'INVALID_EXPECTED_VERSION',
        'expectedVersion 缺失：必须是版本号字符串，首次切换时为 null');
      return;
    }
    if (expectedVersion !== null
      && (typeof expectedVersion !== 'string' || !VERSION_RE.test(expectedVersion.trim()))) {
      sendError(res, 400, 'INVALID_EXPECTED_VERSION',
        'expectedVersion 必须是版本号字符串或 null');
      return;
    }

    try {
      const rec = await store.setActive(
        targetModel,
        releaseVersion.trim(),
        expectedVersion === null ? null : expectedVersion.trim(),
      );
      const meta = store.get(rec.version);
      // ETag 与设备随后在稳定地址下载到的发布件 ETag 完全一致，可直接用于 If-Range
      sendJson(res, 200, {
        targetModel: rec.targetModel,
        activeVersion: rec.version,
        switchedAt: rec.switchedAt,
        sha256: meta.sha256,
        size: meta.size,
      }, { ETag: etagOf(meta) });
    } catch (err) {
      if (err instanceof StoreError) {
        sendError(res, err.status, err.code, err.message);
      } else {
        sendError(res, 500, 'INTERNAL_ERROR', `切换活动固件失败: ${err.message}`);
      }
    }
  }

  /**
   * 不可变发布件下载管线（按版本下载与按型号稳定地址下载共用）：
   * HEAD、Range（200/206/416）、If-Range、If-None-Match 语义完全一致，
   * 单次响应的 ETag/Content-Length/Content-Range 与实际字节同属一个版本。
   */
  async function serveArtifact(req, res, meta) {
    const version = meta.version;
    const filePath = store.artifactPath(version);
    const size = meta.size;
    const etag = etagOf(meta);
    const lastModified = new Date(meta.publishedAt);
    const baseHeaders = {
      'Content-Type': meta.contentType || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Last-Modified': lastModified.toUTCString(),
      'Cache-Control': 'no-cache',
    };
    if (meta.filename) {
      baseHeaders['Content-Disposition'] =
        `attachment; filename="${sanitizeFilename(meta.filename)}"`;
    }

    // 条件请求：If-None-Match / If-Modified-Since（不带 Range 时）
    if (!req.headers.range) {
      const inm = req.headers['if-none-match'];
      if (inm && etagInList(inm, etag)) {
        res.writeHead(304, { ETag: etag, 'Last-Modified': baseHeaders['Last-Modified'] });
        res.end();
        return;
      }
    }

    let range = null;
    const rangeHeader = req.headers.range;
    if (rangeHeader !== undefined) {
      const decision = resolveRange(rangeHeader, size);
      if (decision.kind === 'unsatisfiable') {
        // 416 Range Not Satisfiable，带 Content-Range: bytes */<size>
        sendError(res, 416, 'RANGE_NOT_SATISFIABLE',
          `无法满足范围 ${rangeHeader}（资源长度 ${size}）`,
          { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes', ETag: etag });
        return;
      }
      if (decision.kind === 'range') {
        // If-Range：与当前 ETag 不符（或日期不符）时返回完整文件
        const ifRange = req.headers['if-range'];
        if (ifRange === undefined || ifRangeMatches(ifRange, etag, lastModified)) {
          range = { start: decision.start, end: decision.end };
        }
      }
      // decision.kind === 'ignore' | 'none'：回退完整 200
    }

    // 先 stat 以确认文件可读且大小与元数据一致
    let st;
    try {
      st = await stat(filePath);
    } catch {
      sendError(res, 404, 'RELEASE_NOT_FOUND', `版本 ${version} 的文件缺失`);
      return;
    }
    if (st.size !== size) {
      sendError(res, 500, 'STORAGE_CORRUPT', '文件实际大小与发布元数据不一致');
      return;
    }

    if (!range) {
      // 200 完整文件
      res.writeHead(200, {
        ...baseHeaders,
        'Content-Length': size,
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      pipeFile(store.openArtifact(version), res);
      return;
    }

    // 206 Partial Content
    const length = range.end - range.start + 1;
    res.writeHead(206, {
      ...baseHeaders,
      'Content-Length': length,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    pipeFile(store.openArtifact(version, range), res);
  }

  const server = http.createServer(handler);
  server.waitForReady = () => store.init();
  server.store = store;
  return server;
}

function etagOf(meta) {
  return `"${meta.sha256}"`;
}

function etagInList(header, etag) {
  return header
    .split(',')
    .map((s) => s.trim())
    .some((t) => t === '*' || t === etag || t === `W/${etag}`);
}

function sanitizeFilename(name) {
  return name.replace(/[\x00-\x1f\x7f"\\]/g, '_').slice(0, 128) || 'artifact';
}

function pipeFile(rs, res) {
  rs.on('error', () => {
    if (!res.headersSent) {
      res.destroy();
    } else {
      res.destroy();
    }
  });
  res.on('close', () => rs.destroy());
  rs.pipe(res);
}

function drain(req) {
  req.resume();
}

/** 读取并解析有大小上限的 JSON 请求体；非法 JSON / 超限抛出带 status 的错误 */
async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let len = 0;
  for await (const chunk of req) {
    len += chunk.length;
    if (len > maxBytes) {
      req.destroy();
      const err = new Error(`请求体超过 ${maxBytes} 字节上限`);
      err.status = 413;
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    const err = new Error('请求体不是合法 JSON');
    err.status = 400;
    err.code = 'INVALID_JSON_BODY';
    throw err;
  }
  return parsed;
}

export async function startServer() {
  const port = Number.parseInt(process.env.PORT || '8080', 10);
  const host = process.env.HOST || '0.0.0.0';
  const dataDir = process.env.DATA_DIR || '/data';
  const maxUploadBytes = Number.parseInt(
    process.env.MAX_UPLOAD_BYTES || String(40 * 1024 * 1024), 10,
  );

  const server = createServer({ dataDir, maxUploadBytes });
  await server.waitForReady();

  await new Promise((resolve) => {
    server.listen(port, host, resolve);
  });
  // 轻量日志，便于 Compose 排障
  console.log(`[firmware] listening on http://${host}:${port} data=${dataDir} maxUpload=${maxUploadBytes}`);
  return server;
}

// 仅作为入口直接运行时启动；被测试 import 时不自动监听
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((err) => {
    console.error('[firmware] 启动失败:', err);
    process.exit(1);
  });
}
