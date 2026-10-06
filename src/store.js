// 固件发布存储：持久化到 DATA_DIR，发布动作原子化，重启后既有版本仍可下载。
// 目录结构：
//   <data>/staging/<id>/{artifact,meta.json}   发布中的暂存区
//   <data>/releases/<version>/{artifact,meta.json}  已发布（不可变）
import {
  createReadStream,
  createWriteStream,
} from 'node:fs';
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const HEX64 = /^[a-f0-9]{64}$/i;
export const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export class StoreError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'StoreError';
    this.status = status;
    this.code = code;
  }
}

export class FirmwareStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.releasesDir = path.join(dataDir, 'releases');
    this.stagingDir = path.join(dataDir, 'staging');
    /** @type {Map<string, any>} version -> meta */
    this.meta = new Map();
  }

  async init() {
    await mkdir(this.releasesDir, { recursive: true });
    await mkdir(this.stagingDir, { recursive: true });
    // 清理上次崩溃残留的暂存区
    let entries = [];
    try {
      entries = await readdir(this.stagingDir, { withFileTypes: true });
    } catch { /* ignore */ }
    await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map((e) => rm(path.join(this.stagingDir, e.name), { recursive: true, force: true })),
    );

    // 载入已发布版本（缺少 meta.json 的残缺目录直接忽略）
    const rels = await readdir(this.releasesDir, { withFileTypes: true });
    for (const e of rels) {
      if (!e.isDirectory()) continue;
      try {
        const meta = JSON.parse(await readFile(path.join(this.releasesDir, e.name, 'meta.json'), 'utf8'));
        if (!meta || meta.version !== e.name || !HEX64.test(meta.sha256 || '')) continue;
        await access(path.join(this.releasesDir, e.name, 'artifact'));
        this.meta.set(meta.version, Object.freeze({ ...meta }));
      } catch { /* 残缺目录：忽略，不污染已发布视图 */ }
    }
  }

  list() {
    return [...this.meta.values()].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  }

  get(version) {
    return this.meta.get(version) || null;
  }

  artifactPath(version) {
    return path.join(this.releasesDir, version, 'artifact');
  }

  /**
   * 原子发布一个已上传的临时文件。
   * 校验失败（缺字段/摘要不符/版本重复）时绝不写入 releases 目录。
   */
  async publish({ fields, file }) {
    const version = (fields.version || '').trim();
    const targetModel = (fields.targetModel || '').trim();
    const claimedSha = (fields.sha256 || '').trim().toLowerCase();

    if (!VERSION_RE.test(version)) {
      throw new StoreError('version 缺失或非法（允许 1-64 位字母数字与 ._+-，且首字符为字母数字）', 400, 'INVALID_VERSION');
    }
    if (!targetModel || targetModel.length > 128) {
      throw new StoreError('targetModel 缺失或过长（最长 128）', 400, 'INVALID_TARGET_MODEL');
    }
    if (!HEX64.test(claimedSha)) {
      throw new StoreError('sha256 缺失或不是 64 位十六进制摘要', 400, 'INVALID_SHA256');
    }
    if (!file) {
      throw new StoreError('缺少 artifact 文件字段', 400, 'MISSING_ARTIFACT');
    }

    // 1) 摘要校验（解析器已流式计算过一遍）。不符则丢弃临时文件，不得落盘到发布区。
    if (file.sha256.toLowerCase() !== claimedSha) {
      await rm(file.path, { force: true }).catch(() => {});
      throw new StoreError(
        `摘要校验失败：期望 ${claimedSha}，实际 ${file.sha256.toLowerCase()}`,
        422,
        'SHA256_MISMATCH',
      );
    }

    if (this.meta.has(version)) {
      await rm(file.path, { force: true }).catch(() => {});
      throw new StoreError(`版本 ${version} 已发布，已发布版本不可覆盖`, 409, 'VERSION_EXISTS');
    }

    // 2) 暂存目录中组装 artifact + meta.json，再整体原子改名到 releases/<version>
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const stage = path.join(this.stagingDir, id);
    await mkdir(stage, { recursive: true });
    try {
      const stagedArtifact = path.join(stage, 'artifact');
      await rename(file.path, stagedArtifact);

      // 防御性二次校验：从暂存文件重新流式计算摘要，确保落盘字节与声明一致
      const actualSha = await hashFile(stagedArtifact);
      if (actualSha !== claimedSha) {
        throw new StoreError('暂存文件摘要与声明不符', 422, 'SHA256_MISMATCH');
      }
      const st = await stat(stagedArtifact);

      const meta = {
        version,
        targetModel,
        sha256: claimedSha,
        size: st.size,
        filename: file.filename,
        contentType: file.contentType,
        publishedAt: new Date().toISOString(),
      };
      await writeFileAtomic(path.join(stage, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

      const finalDir = path.join(this.releasesDir, version);
      try {
        // POSIX 上 rename 到已存在的非空目录会失败（ENOTEMPTY/EEXIST），
        // 由此挡住并发的重复版本发布，且不会破坏既有发布。
        await rename(stage, finalDir);
      } catch (err) {
        if (err.code === 'ENOTEMPTY' || err.code === 'EEXIST') {
          // 并发抢发：重新确认既有版本并报 409
          if (this.meta.has(version) || await pathExists(path.join(finalDir, 'meta.json'))) {
            throw new StoreError(`版本 ${version} 已发布，已发布版本不可覆盖`, 409, 'VERSION_EXISTS');
          }
        }
        throw err;
      }

      const frozen = Object.freeze({ ...meta });
      this.meta.set(version, frozen);
      return frozen;
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => {});
      // 若临时文件仍在（rename 未执行），一并清理
      await rm(file.path, { force: true }).catch(() => {});
    }
  }

  /** 打开某版本 artifact 的只读流（供范围/全量响应使用） */
  openArtifact(version, range) {
    const p = this.artifactPath(version);
    if (range) return createReadStream(p, { start: range.start, end: range.end });
    return createReadStream(p);
  }
}

async function writeFileAtomic(p, data) {
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, data, { encoding: 'utf8' });
  await rename(tmp, p);
}

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function hashFile(p) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const rs = createReadStream(p);
    rs.on('error', reject);
    rs.on('data', (c) => hash.update(c));
    rs.on('end', () => resolve(hash.digest('hex')));
  });
}

// 供上传解析器使用的 createWriteStream 再导出（保持引用集中）
export { createWriteStream };
