#!/bin/sh
# verify 一次性服务入口：代码测试 → 构建（语法）检查 → 发布后分段重组 API 冒烟。
# 依赖 app 服务通过健康检查后启动；以退出码报告总体结果。
set -eu

echo "=================== 1/3 代码测试（node --test） ==================="
node --test test/range.test.js test/multipart.test.js test/store.test.js test/http.test.js

echo "=================== 2/3 构建检查（node --check 语法校验） ==================="
for f in src/*.js scripts/*.mjs; do
  node --check "$f"
  echo "  ok  $f"
done

echo "=================== 3/3 发布后分段重组 API 冒烟 ==================="
exec node scripts/smoke.mjs
