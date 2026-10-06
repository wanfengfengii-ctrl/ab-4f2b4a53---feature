// multipart/form-data 流式解析器（零依赖）
// 文件 part 直接落盘到临时目录并同步计算 SHA-256；普通字段收入内存（有上限）。
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';

export class MultipartError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'MultipartError';
    this.status = status;
  }
}

/** 基于请求流的字节缓冲读取器 */
class ByteReader {
  constructor(req) {
    this.req = req;
    this._iter = req[Symbol.asyncIterator]();
    this.buf = Buffer.alloc(0);
    this.ended = false;
  }

  async _pull() {
    if (this.ended) return false;
    const { value, done } = await this._iter.next();
    if (done) {
      this.ended = true;
      return false;
    }
    this.buf = this.buf.length === 0 ? value : Buffer.concat([this.buf, value]);
    return true;
  }

  /** 至少拉取 n 个字节；返回实际可用字节数是否达到 n */
  async ensure(n) {
    while (this.buf.length < n) {
      if (!(await this._pull())) return false; // 流已结束
    }
    return true;
  }

  /** 在流中查找 seq，找到返回索引并消费其之前（含自身）的字节；未找到抛错 */
  async consumeUntil(seq, what) {
    let idx = this.buf.indexOf(seq);
    while (idx === -1) {
      if (!(await this._pull())) {
        throw new MultipartError(`multipart 数据不完整：缺少 ${what}`, 400);
      }
      idx = this.buf.indexOf(seq);
    }
    const out = this.buf.subarray(0, idx);
    this.buf = this.buf.subarray(idx + seq.length);
    return out;
  }

  /**
   * 将直到终止序列之前的所有内容通过 onData 输出（带背压），
   * 终止序列被消费。正确处理终止序列跨 chunk 的情况，返回输出字节总数。
   */
  async streamUntil(seq, onData, maxBytes, what) {
    let total = 0;
    const note = (n) => {
      total += n;
      if (Number.isFinite(maxBytes) && total > maxBytes) {
        throw new MultipartError(`${what}超过大小上限`, 413);
      }
    };
    for (;;) {
      const idx = this.buf.indexOf(seq);
      if (idx !== -1) {
        if (idx > 0) {
          note(idx);
          await onData(this.buf.subarray(0, idx));
        }
        this.buf = this.buf.subarray(idx + seq.length);
        return total;
      }
      // 找不到：输出安全前缀，末尾保留 seq.length-1 字节防止跨 chunk
      const safe = this.buf.length - (seq.length - 1);
      if (safe > 0) {
        note(safe);
        const slice = this.buf.subarray(0, safe);
        this.buf = this.buf.subarray(safe);
        await onData(slice);
      }
      if (!(await this._pull())) {
        throw new MultipartError('multipart 数据不完整：缺少结束 boundary', 400);
      }
    }
  }

  /** 消费前 n 字节 */
  take(n) {
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}

/**
 * 解析 multipart/form-data 请求。
 * @returns {Promise<{fields: Record<string,string>,
 *   files: Record<string,{path:string,size:number,sha256:string,filename:string,contentType:string}>}>}
 */
export async function parseMultipart(req, {
  tmpDir,
  maxFields = 64 * 1024,
  maxFileSize = Infinity,
} = {}) {
  const contentType = req.headers['content-type'] || '';
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw new MultipartError('Content-Type 缺少 multipart boundary', 415);
  const boundary = (m[1] || m[2]).trim().replace(/"$/g, '');
  if (!boundary || boundary.length > 70) {
    throw new MultipartError('非法的 multipart boundary', 400);
  }

  await mkdir(tmpDir, { recursive: true });

  const reader = new ByteReader(req);
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = Object.create(null);
  const files = Object.create(null);
  const created = [];
  let fieldTotal = 0;

  const cleanup = async () => {
    await Promise.all(created.map((p) => rm(p, { force: true }).catch(() => {})));
  };

  try {
    // 跳过前导区（preamble），定位第一个 --boundary
    await reader.consumeUntil(delimiter, '起始 boundary');

    for (;;) {
      // boundary 之后必须是 CRLF（继续某 part）或 --（整个 multipart 结束）
      if (!(await reader.ensure(2))) {
        throw new MultipartError('multipart 数据在 boundary 后截断', 400);
      }
      const two = reader.buf.subarray(0, 2);
      if (two[0] === 0x2d && two[1] === 0x2d) {
        reader.take(2);
        break;
      }
      if (two[0] === 0x0d && two[1] === 0x0a) {
        reader.take(2);
      } else {
        throw new MultipartError('非法的 multipart boundary 后缀', 400);
      }

      // 解析 part 头
      const headerRaw = await reader.consumeUntil(Buffer.from('\r\n\r\n'), 'part 头结束符');
      const headers = parseHeaders(headerRaw);
      const disposition = headers['content-disposition'] || '';
      if (!disposition.startsWith('form-data')) {
        throw new MultipartError('非法的 multipart part（缺少 form-data  disposition）', 400);
      }
      const nameM = /name="([^"]*)"/.exec(disposition);
      if (!nameM) throw new MultipartError('multipart part 缺少 name', 400);
      const name = nameM[1];
      const fileM = /filename="([^"]*)"/.exec(disposition);

      // 终止标记：CRLF + --boundary
      const endMarker = Buffer.concat([Buffer.from('\r\n'), delimiter]);

      if (fileM && fileM[1] !== '') {
        const filename = fileM[1].split(/[\\/]/).pop() || 'artifact';
        const tmpPath = `${tmpDir}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.tmp`;
        created.push(tmpPath);
        const stream = createWriteStream(tmpPath);
        const hash = createHash('sha256');
        let size = 0;
        await new Promise((resolve, reject) => {
          stream.once('error', reject);
          reader.streamUntil(endMarker, async (buf) => {
            hash.update(buf);
            size += buf.length;
            if (!stream.write(buf)) {
              await new Promise((r) => stream.once('drain', r));
            }
          }, maxFileSize, '上传文件').then(() => {
            stream.end(() => resolve());
          }, reject);
        });
        files[name] = {
          path: tmpPath,
          size,
          sha256: hash.digest('hex'),
          filename,
          contentType: headers['content-type'] || 'application/octet-stream',
        };
      } else {
        const chunks = [];
        let size = 0;
        await reader.streamUntil(endMarker, async (buf) => {
          chunks.push(Buffer.from(buf));
          size += buf.length;
          if (fieldTotal + size > maxFields) {
            throw new MultipartError('普通字段总大小超限', 413);
          }
        }, maxFields, '字段');
        fieldTotal += size;
        fields[name] = Buffer.concat(chunks, size).toString('utf8');
      }

      // 消费下一个 boundary 后的两字节判定放在循环开头；这里已消费 endMarker（含 delimiter）
    }
  } catch (err) {
    req.destroy();
    await cleanup();
    if (err instanceof MultipartError) throw err;
    throw new MultipartError(`multipart 解析失败: ${err.message}`, 400);
  }

  return { fields, files, cleanup };
}

function parseHeaders(raw) {
  const headers = Object.create(null);
  for (const line of raw.toString('utf8').split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}
