# 海上风机固件发布/续传服务镜像（零运行时依赖，构建无需联网安装包）
FROM node:22-alpine

WORKDIR /app

# 零依赖应用：仅拷贝源码与内置测试/冒烟脚本（verify 服务复用同一镜像）
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test

# 非 root 运行；持久化数据目录归属运行用户
RUN addgroup -S app && adduser -S app -G app \
  && mkdir -p /data \
  && chown -R app:app /app /data

USER app

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0

EXPOSE 8080

# 镜像级健康检查（compose 中另有等价配置用于控制 verify 的启动时机）
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
