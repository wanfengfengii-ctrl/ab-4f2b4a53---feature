// 固件发布存储：持久化到 DATA_DIR，发布动作原子化，重启后既有版本仍可下载。
// 目录结构：
//   <data>/staging/<id>/{artifact,meta.json}        发布中的暂存区
//   <data>/releases/<version>/{artifact,meta.json}  已发布（不可变）
//   <data>/active/<encodedModel>.json               型号 -> 活动版本映射（原子写入）
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
    this.activeDir = path.join(dataDir, 'active');
    /** @type {Map<string, any>} version -> meta */
    this.meta = new Map();
    /** @type {Map<string, any>} targetModel -> 活动记录 {version, switchedAt} */
    this.active = new Map();
    /** @type {Map<string, Promise<unknown>>} 按型号串行化活动切换，杜绝并发竞争产生混合状态 */
    this.activeLocks = new Map();
  }

  async init() {
    await mkdir(this.releasesDir, { recursive: true });
    await mkdir(this.stagingDir, { recursive: true });
    await mkdir(this.activeDir, { recursive: true });
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

    // 载入型号 -> 活动版本映射。映射只指向不可变发布件：
    // 指向缺失/损坏发布件的记录视为孤儿，忽略（绝不回退到其他版本拼接）。
    let actEntries = [];
    try {
      actEntries = await readdir(this.activeDir, { withFileTypes: true });
    } catch { /* ignore */ }
    // 清理崩溃残留的原子写临时文件
    await Promise.all(
      actEntries
        .filter((e) => e.isFile() && e.name.includes('.tmp-'))
        .map((e) => rm(path.join(this.activeDir, e.name), { force: true }).catch(() => {})),
    );
    for (const e of actEntries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(await readFile(path.join(this.activeDir, e.name), 'utf8'));
        if (!rec || typeof rec.targetModel !== 'string' || typeof rec.version !== 'string') continue;
        if (e.name !== encodeModel(rec.targetModel)) continue;
        const meta = this.meta.get(rec.version);
        if (!meta || meta.targetModel !== rec.targetModel) continue;
        this.active.set(rec.targetModel, Object.freeze({
          targetModel: rec.targetModel,
          version: rec.version,
          switchedAt: typeof rec.switchedAt === 'string' ? rec.switchedAt : '',
        }));
      } catch { /* 残缺映射文件：忽略 */ }
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

  /** 某型号当前活动记录 {targetModel, version, switchedAt}，未切换过返回 null */
  getActive(targetModel) {
    return this.active.get(targetModel) || null;
  }

  /** 某型号当前活动发布件的不可变元数据；从未切换返回 null */
  getActiveMeta(targetModel) {
    const rec = this.active.get(targetModel);
    return rec ? this.meta.get(rec.version) || null : null;
  }

  /**
   * 将某型号的活动固件切换为指定发布版本。
   * - 发布件不存在：RELEASE_NOT_FOUND(404)
   * - 发布件型号与目标型号不一致：MODEL_MISMATCH(409)
   * - expectedVersion 与切换前活动版本不符（首次切换须为 null）：VERSION_CONFLICT(409)
   * 切换以“读旧映射 → 校验 → 原子替换文件 → 更新内存”为临界区，按型号串行，
   * 因此并发竞争只有一个请求成功，其余拿到 409 且活动版本保持为最后一次成功切换。
   */
  async setActive(targetModel, releaseVersion, expectedVersion) {
    if (!targetModel || targetModel.length > 128) {
      throw new StoreError('targetModel 缺失或过长（最长 128）', 400, 'INVALID_TARGET_MODEL');
    }
    return this.#withActiveLock(targetModel, async () => {
      const meta = this.meta.get(releaseVersion);
      if (!meta) {
        throw new StoreError(`发布版本 ${releaseVersion} 不存在`, 404, 'RELEASE_NOT_FOUND');
      }
      if (meta.targetModel !== targetModel) {
        throw new StoreError(
          `发布版本 ${releaseVersion} 的型号为 ${meta.targetModel}，无法切换到型号 ${targetModel}`,
          409,
          'MODEL_MISMATCH',
        );
      }
      const current = this.active.get(targetModel) || null;
      const currentVersion = current ? current.version : null;
      if (expectedVersion !== currentVersion) {
        throw new StoreError(
          currentVersion === null
            ? `型号 ${targetModel} 从未切换活动固件，expectedVersion 必须为 null`
            : `前置版本不匹配：expectedVersion=${formatExpected(expectedVersion)}，当前活动版本为 ${currentVersion}`,
          409,
          'VERSION_CONFLICT',
        );
      }

      const record = {
        targetModel,
        version: releaseVersion,
        switchedAt: new Date().toISOString(),
      };
      // 先写新映射文件再更新内存；原子 rename 保证重启后看到的是完整记录
      const file = path.join(this.activeDir, encodeModel(targetModel));
      await writeFileAtomic(file, JSON.stringify(record, null, 2) + '\n');
      const frozen = Object.freeze({ ...record });
      this.active.set(targetModel, frozen);
      return frozen;
    });
  }

  /** 按型号串行执行活动切换临界区 */
  async #withActiveLock(targetModel, fn) {
    const prev = this.activeLocks.get(targetModel) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    // 后继者无论前任成败都要进入，但必须等前任完全退出临界区
    this.activeLocks.set(targetModel, prev.then(() => gate, () => gate));
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
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

/**
 * 型号名 -> 活动映射文件名。型号可含非 ASCII 字符与路径分隔符，不能直接做文件名，
 * 也不宜做转义（转义结果仍可能超出 255 字节限制），故采用 SHA-256 定长摘要；
 * 映射文件内部完整记录 targetModel，载入时重新核对。
 */
function encodeModel(model) {
  return `model-${createHash('sha256').update(model, 'utf8').digest('hex')}.json`;
}

function formatExpected(v) {
  return v === null ? 'null' : JSON.stringify(v);
}

// 供上传解析器使用的 createWriteStream 再导出（保持引用集中）
export { createWriteStream };
