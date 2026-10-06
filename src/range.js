// RFC 7233 单区间 byte-range 解析。
// 支持三种形态：bytes=start-end（闭区间）、bytes=start-（开放尾端）、bytes=-suffix（后缀）。
//
// 返回三态：
//   { kind: 'range', start, end }  闭区间
//   { kind: 'ignore' }             无法理解/不支持的 Range 头 → 服务端应回退完整 200
//   { kind: 'unsatisfiable' }      语法可识别但无法满足 → 服务端应返回 416

/**
 * @param {string|undefined} header
 * @param {number} size 资源总字节数
 */
export function resolveRange(header, size) {
  if (header === undefined || header === null) return { kind: 'none' };
  const trimmed = header.trim();
  if (trimmed === '') return { kind: 'ignore' };

  const dashIdx = trimmed.indexOf('=');
  if (dashIdx === -1) return { kind: 'ignore' };
  const unit = trimmed.slice(0, dashIdx).trim().toLowerCase();
  if (unit !== 'bytes') return { kind: 'ignore' }; // 其他单位：忽略 Range

  const spec = trimmed.slice(dashIdx + 1).trim();
  if (spec === '') return { kind: 'ignore' };
  if (spec.includes(',')) return { kind: 'ignore' }; // 仅支持单区间；多区间回退完整表示

  const eq = spec.indexOf('-');
  if (eq === -1) return { kind: 'ignore' };
  const left = spec.slice(0, eq).trim();
  const right = spec.slice(eq + 1).trim();

  if (left === '') {
    // 后缀形式：bytes=-suffix
    if (!/^\d+$/.test(right)) return { kind: 'ignore' };
    const suffixLen = Number(right);
    if (size === 0 || suffixLen === 0) return { kind: 'unsatisfiable' };
    const start = Math.max(0, size - suffixLen);
    return { kind: 'range', start, end: size - 1 };
  }

  if (!/^\d+$/.test(left)) return { kind: 'ignore' };
  const start = Number(left);

  if (right === '') {
    // 开放尾端：bytes=start-
    if (start >= size) return { kind: 'unsatisfiable' };
    return { kind: 'range', start, end: size - 1 };
  }

  if (!/^\d+$/.test(right)) return { kind: 'ignore' };
  const end = Number(right);
  // RFC 7233 §2.1：last-byte-pos 小于 first-byte-pos 时该区间非法，应忽略整个 Range（回退 200）
  if (end < start) return { kind: 'ignore' };
  if (start >= size) return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end: Math.min(end, size - 1) };
}

/** 比较 If-Range 与当前验证子：ETag 强比较，或 HTTP-date 与 Last-Modified 比较 */
export function ifRangeMatches(ifRange, etag, lastModified) {
  const value = ifRange.trim();
  // ETag 验证子（含弱验证子前缀；弱验证子不能用于范围请求的前提条件）
  if (value.startsWith('"') || value.startsWith("'") || value.startsWith('W/')) {
    return value === etag;
  }
  // 视作 HTTP-date
  const t = Date.parse(value);
  if (Number.isNaN(t) || !lastModified) return false;
  return Math.floor(lastModified.getTime() / 1000) === Math.floor(t / 1000);
}
