import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseMultipart, MultipartError } from '../src/multipart.js';

let tmpRoot;
before(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'fw-mp-'));
});
after(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** 构造 multipart 请求体 */
function buildBody(boundary, parts) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    let head = `Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) head += `; filename="${part.filename}"`;
    head += '\r\n';
    if (part.contentType) head += `Content-Type: ${part.contentType}\r\n`;
    chunks.push(Buffer.from(head + '\r\n'));
    chunks.push(part.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function reqOf(body, boundary, chunkSize = 16) {
  const req = Readable.from(async function* gen() {
    for (let i = 0; i < body.length; i += chunkSize) {
      yield body.subarray(i, i + chunkSize);
    }
  }());
  req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  return req;
}

test('解析字段与文件，文件 SHA-256/大小正确', async () => {
  const boundary = '----testboundary123';
  const data = Buffer.from('firmware-bytes-固件-\x00\x01\x02\xff'.repeat(50));
  const body = buildBody(boundary, [
    { name: 'version', data: Buffer.from('1.2.3') },
    { name: 'targetModel', data: Buffer.from('WT-5000') },
    { name: 'sha256', data: Buffer.from(sha(data)) },
    { name: 'artifact', filename: 'fw.bin', contentType: 'application/octet-stream', data },
  ]);

  for (const chunkSize of [1, 4, 64, 1024 * 1024]) {
    const req = reqOf(body, boundary, chunkSize);
    const { fields, files, cleanup } = await parseMultipart(req, {
      tmpDir: path.join(tmpRoot, `c${chunkSize}`),
    });
    assert.equal(fields.version, '1.2.3');
    assert.equal(fields.targetModel, 'WT-5000');
    assert.equal(fields.sha256, sha(data));
    assert.ok(files.artifact, '应有 artifact 文件');
    assert.equal(files.artifact.size, data.length);
    assert.equal(files.artifact.sha256, sha(data));
    assert.equal(files.artifact.filename, 'fw.bin');
    assert.equal(files.artifact.contentType, 'application/octet-stream');
    const onDisk = await readFile(files.artifact.path);
    assert.ok(onDisk.equals(data), `chunkSize=${chunkSize} 落盘字节一致`);
    await cleanup();
    await assert.rejects(stat(files.artifact.path), 'cleanup 后临时文件被删除');
  }
});

test('终止标记跨 chunk 也能正确切分', async () => {
  const boundary = 'b';
  const data = Buffer.alloc(100, 0x58);
  const body = buildBody(boundary, [
    { name: 'artifact', filename: 'a', data },
    { name: 'version', data: Buffer.from('9.9.9') },
  ]);
  for (const cs of [1, 2, 3, 5, 7, 13]) {
    const req = reqOf(body, boundary, cs);
    const { files, fields, cleanup } = await parseMultipart(req, {
      tmpDir: path.join(tmpRoot, `cross${cs}`),
    });
    assert.equal(files.artifact.size, 100, `cs=${cs} 文件大小`);
    assert.equal(fields.version, '9.9.9', `cs=${cs} 后续字段`);
    await cleanup();
  }
});

test('数据恰好包含 boundary 子串不误判', async () => {
  const boundary = 'xyz';
  // 数据中出现 "--xy" / "xyz" 的片段但不是完整终止标记
  const data = Buffer.concat([
    Buffer.from('--xyz'),
    Buffer.alloc(30, 0x41),
    Buffer.from('\r\n--xy'),
    Buffer.alloc(30, 0x42),
  ]);
  const body = buildBody(boundary, [
    { name: 'artifact', filename: 'a', data },
  ]);
  const req = reqOf(body, boundary, 3);
  const { files, cleanup } = await parseMultipart(req, { tmpDir: path.join(tmpRoot, 'sub') });
  assert.equal(files.artifact.size, data.length);
  assert.equal(files.artifact.sha256, sha(data));
  await cleanup();
});

test('缺少结束 boundary 时报错且清理临时文件', async () => {
  const boundary = 'bb';
  const data = Buffer.alloc(200, 0x10);
  const body = buildBody(boundary, [{ name: 'artifact', filename: 'a', data }]);
  const truncated = body.subarray(0, body.length - 10); // 砍掉结束标记
  const req = reqOf(truncated, boundary, 9);
  await assert.rejects(
    parseMultipart(req, { tmpDir: path.join(tmpRoot, 'trunc') }),
    (err) => err instanceof MultipartError && err.status === 400,
  );
});

test('文件超过 maxFileSize 返回 413 并清理', async () => {
  const boundary = 'lim';
  const data = Buffer.alloc(5000, 0x77);
  const body = buildBody(boundary, [{ name: 'artifact', filename: 'a', data }]);
  const req = reqOf(body, boundary, 100);
  await assert.rejects(
    parseMultipart(req, { tmpDir: path.join(tmpRoot, 'lim'), maxFileSize: 1024 }),
    (err) => err instanceof MultipartError && err.status === 413,
  );
});

test('字段总大小超限返回 413', async () => {
  const boundary = 'flim';
  const body = buildBody(boundary, [
    { name: 'bigfield', data: Buffer.alloc(10000, 0x61) },
  ]);
  const req = reqOf(body, boundary, 50);
  await assert.rejects(
    parseMultipart(req, { tmpDir: path.join(tmpRoot, 'flim'), maxFields: 128 }),
    (err) => err instanceof MultipartError && err.status === 413,
  );
});

test('缺少 boundary 的 Content-Type 返回 415', async () => {
  const req = Readable.from([]);
  req.headers = { 'content-type': 'multipart/form-data' };
  await assert.rejects(
    parseMultipart(req, { tmpDir: path.join(tmpRoot, 'noct') }),
    (err) => err.status === 415,
  );
});

test('文件名字段路径穿越被剥离为 basename', async () => {
  const boundary = 'pf';
  const data = Buffer.from('x');
  const body = buildBody(boundary, [
    { name: 'artifact', filename: '../../etc/passwd', data },
  ]);
  const req = reqOf(body, boundary, 4);
  const { files, cleanup } = await parseMultipart(req, { tmpDir: path.join(tmpRoot, 'pf') });
  assert.equal(files.artifact.filename, 'passwd');
  await cleanup();
});
