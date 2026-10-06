# 海上风机控制器固件发布与分段续传服务

为窄带链路下的风机控制器固件下载提供**可中断、可续传、字节完全一致**的发布与分发服务。
零运行时依赖（仅使用 Node.js 内置模块），发布即原子落盘，服务重启后既有版本仍可下载。

## 能力概览

- `POST /api/firmware/releases`：`multipart/form-data` 发布
  - 字段：`version`、`targetModel`、`sha256`（64 位十六进制）、文件字段 `artifact`
  - 上传时流式计算 SHA-256，**摘要不符返回 `422` 且绝不写入发布区**
  - **已发布版本不可覆盖**：重复发布返回 `409`，原文件字节不变
  - 成功返回 `201`、`ETag: "<sha256>"` 与 `Location`
- `GET /api/firmware/releases/{version}/artifact`（亦支持 `HEAD`）
  - 无 `Range`：`200` 完整文件
  - 单个闭区间 `bytes=a-b`、开放尾端 `bytes=a-`、后缀 `bytes=-n`：`206 Partial Content`
  - 无法满足的范围：`416 Range Not Satisfiable`，带 `Content-Range: bytes */<size>`
  - 无法识别/不支持的 Range（非 `bytes` 单位、多区间、倒挂区间等）：按 HTTP 语义忽略，回退 `200`
  - `If-Range` 与当前 `ETag`（或 `Last-Modified`）不符时返回完整文件 `200`
  - `If-None-Match` 命中返回 `304`
  - 所有成功响应的 `ETag`、`Content-Length`、`Content-Range` 均与实际字节严格一致
- `GET /api/firmware/releases`：已发布版本清单
- `POST /api/firmware/models/{targetModel}/active`：把不可变发布件切换为某型号的活动固件
  - 请求体 JSON：`{"releaseVersion": "1.4.2", "expectedVersion": "1.4.1" | null}`
  - 仅**型号一致**的发布件可被切换（不符返回 `409 MODEL_MISMATCH`；未知发布返回 `404`）
  - `expectedVersion` 须等于切换前的活动版本（CAS）；**首次切换须为 `null`**
  - 前置版本过期或并发竞争失败返回 `409 VERSION_CONFLICT`，活动版本不变；
    同一时刻只有一个切换成功
  - 成功返回 `200`、活动版本、`previousVersion` 与 `ETag: "<sha256>"`（活动发布件摘要）
- `GET /api/firmware/models/{targetModel}/artifact`（亦支持 `HEAD`）：设备稳定取件地址
  - 完整复用按版本下载的 `Range`、`If-Range`、`If-None-Match` 与 `200/206/304/416` 语义
  - 活动版本在请求开始时一次性解析，**单次响应的字节与校验头同属一个版本**，绝不拼接新旧版本
  - 尚未设置活动固件的型号返回 `404 ACTIVE_NOT_FOUND`
- `GET /healthz`：健康检查

## 一致性保证

1. 上传文件先落临时目录并流式哈希；与声明摘要不符立即丢弃（`422`）。
2. 通过校验后在暂存目录组装 `artifact` + `meta.json`，再以目录级原子 `rename` 发布；
   并发重复版本由文件系统改名冲突兜底，返回 `409`，不破坏既有发布。
3. ETag 即发布字节的 SHA-256；下载前校验磁盘文件大小与元数据一致。
4. 已发布数据位于持久卷 `/data`，重启后自动加载；崩溃残留的暂存目录启动时清理。
5. 活动固件切换经串行队列裁决：`expectedVersion` 校验、映射原子落盘（写临时文件再
   `rename`）、内存提交依次完成；并发竞争只有一个成功，其余 `409` 且活动版本不变。
   映射持久化于 `/data/active.json`，重启后保持；设备端单次响应的字节与 ETag 始终
   来自同一个不可变发布件。

## 目录结构

```
src/
  server.js      HTTP 路由、发布与 Range 下载
  multipart.js  零依赖流式 multipart/form-data 解析（背压、限额、临时文件清理）
  range.js      RFC 7233 单区间与 If-Range 解析
  store.js      原子发布、摘要校验、持久化元数据
test/           node:test 单元 + HTTP 集成测试（54 项，含活动固件切换验收）
scripts/
  smoke.mjs     发布后分段重组 API 冒烟
  verify.sh     verify 一次性服务入口
Dockerfile      可构建应用镜像
docker-compose.yml  健康检查 + 持久卷 + 可配置宿主机端口 + verify 一次性服务
```

## 本地运行（无需安装依赖）

```bash
node src/server.js                       # 默认 :8080，数据目录 /data（可用 DATA_DIR 覆盖）
PORT=18080 DATA_DIR=./data node src/server.js
npm test                                 # 单元 + 集成测试
node scripts/smoke.mjs                   # 对运行中的服务做 API 冒烟（APP_URL 可覆盖）
```

## Docker / Compose

```bash
# 构建并启动应用；verify 会在应用健康通过后自动运行（退出码即结论）
docker compose up --build

# 宿主机端口可配置（默认 8080）
HOST_PORT=9090 docker compose up -d --build

# 单独重跑一次性校验
docker compose run --rm verify
```

- 持久卷：命名卷 `firmware-data` 挂载到 `/data`。
- 健康检查：容器内用 Node 内置 `fetch` 探测 `/healthz`（镜像不含 curl/wget）。
- verify 服务 `depends_on: app (service_healthy)`，依次执行：
  代码测试（`node --test`）→ 构建检查（`node --check`）→ 分段重组 API 冒烟，并以退出码报告。

## 使用示例

```bash
# 发布
SHA=$(sha256sum fw-1.4.2.bin | cut -d' ' -f1)
curl -f -X POST http://localhost:8080/api/firmware/releases \
  -F version=1.4.2 -F targetModel=WT-5000 -F sha256="$SHA" \
  -F artifact=@fw-1.4.2.bin

# 续传下载（中断后用同一 Range 重发即可）
curl -f -H 'Range: bytes=1048576-' \
  -H 'If-Range: "<sha256>"' \
  http://localhost:8080/api/firmware/releases/1.4.2/artifact -o part.bin

# 运维切换：把 1.4.2 设为 WT-5000 的活动固件（首次切换 expectedVersion 为 null）
curl -f -X POST http://localhost:8080/api/firmware/models/WT-5000/active \
  -H 'Content-Type: application/json' \
  -d '{"releaseVersion":"1.4.2","expectedVersion":null}'

# 设备从稳定地址取件（活动版本切换后自动指向新发布件，地址不变）
curl -f -H 'Range: bytes=0-1048575' \
  http://localhost:8080/api/firmware/models/WT-5000/artifact -o fw.part
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 容器内监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `/data` | 发布数据与临时文件目录 |
| `MAX_UPLOAD_BYTES` | `41943040`（40MiB） | 单次上传体积上限 |
| `HOST_PORT`（compose） | `8080` | 宿主机映射端口 |
