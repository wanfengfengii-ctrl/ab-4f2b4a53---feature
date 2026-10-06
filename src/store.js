// 固件发布存储：持久化到 DATA_DIR，发布动作原子化，重启后既有版本仍可下载。
// 目录结构：
//   <data>/staging/<id>/{artifact,meta.json}   发布中的暂存区
//   <data>/releases/<version>/{artifact,meta.json}  已发布（不可变）
//   <data>/active.json                          各型号当前活动固件映射（原子写，重启保持）
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
    this.activeFile = path.join(dataDir, 'active.json');
    /** @type {Map<string, any>} version -> meta */
    this.meta = new Map();
    /** @type {Map<string, any>} targetModel -> { targetModel, version, previousVersion, switchedAt } */
    this.active = new Map();
    // 切换操作的串行队列：保证“读当前值-校验前置版本-落盘-提交”不被并发切换交错
    this._activeQueue = Promise.resolve();
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

    // 载入各型号活动固件映射（重启保持）。文件经原子写产生，缺失视为空映射；
    // 与残缺发布目录的容忍策略一致，无法解析时按空映射启动而不阻断服务。
    try {
      const raw = JSON.parse(await readFile(this.activeFile, 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const [model, rec] of Object.entries(raw)) {
          if (rec && typeof rec.version === 'string' && VERSION_RE.test(rec.version)) {
            this.active.set(model, Object.freeze({
              targetModel: model,
              version: rec.version,
              previousVersion: typeof rec.previousVersion === 'string' ? rec.previousVersion : null,
              switchedAt: rec.switchedAt || null,
            }));
          }
        }
      }
    } catch { /* 无映射文件或内容损坏：按空映射启动 */ }
  }

  list() {
    return [...this.meta.values()].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  }

  get(version) {
    return this.meta.get(version) || null;
  }

  /** 某型号当前活动固件记录；未设置返回 null */
  getActive(targetModel) {
    return this.active.get(targetModel) || null;
  }

  /**
   * 将某型号的活动固件切换到指定发布版本（CAS 语义）。
   * - 仅型号一致的发布件可被切换；
   * - expectedVersion 必须等于切换前的活动版本（首次切换为 null）；
   * - 并发切换经串行队列裁决，只有一个成功，其余抛 409 且活动版本不变。
   * 映射先原子落盘再提交内存，重启后保持。
   */
  async switchActive(targetModel, releaseVersion, expectedVersion) {
    const release = this.meta.get(releaseVersion);
    if (!release) {
      throw new StoreError(`发布版本 ${releaseVersion} 不存在`, 404, 'RELEASE_NOT_FOUND');
    }
    if (release.targetModel !== targetModel) {
      throw new StoreError(
        `发布版本 ${releaseVersion} 属于型号 ${release.targetModel}，不能切换为型号 ${targetModel} 的活动固件`,
        409,
        'MODEL_MISMATCH',
      );
    }

    const run = this._activeQueue.then(async () => {
      const prev = this.active.get(targetModel) || null;
      const prevVersion = prev ? prev.version : null;
      if (expectedVersion !== prevVersion) {
        throw new StoreError(
          `expectedVersion 与当前活动版本不符：期望 ${JSON.stringify(expectedVersion)}，`
          + `当前 ${JSON.stringify(prevVersion)}`,
          409,
          'VERSION_CONFLICT',
        );
      }
      const record = Object.freeze({
        targetModel,
        version: releaseVersion,
        previousVersion: prevVersion,
        switchedAt: new Date().toISOString(),
      });
      const next = new Map(this.active);
      next.set(targetModel, record);
      // 先原子落盘（写临时文件再 rename），成功后才提交内存视图
      await writeFileAtomic(
        this.activeFile,
        JSON.stringify(Object.fromEntries(next), null, 2) + '\n',
      );
      this.active = next;
      return record;
    });
    // 队列自身永不拒绝：前序切换失败不影响后续切换的裁决
    this._activeQueue = run.catch(() => {});
    return run;
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
