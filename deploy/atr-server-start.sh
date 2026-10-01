#!/bin/bash
# ai-token-report 部门服务端的 PM2 启动包装。
#
# ★ 本文件**在仓库里**，由 `bun run deploy:server:apply --runtime bun|node` 上传安装：
#   安装前先把线上那一份备份进 `.deploy-backup-<时间戳>/`，健康检查失败会连它一起回滚。
#   🚨 **不要去改服务器上那一份** —— 下次部署会覆盖它，改动会静默丢失。
#   要改运行时，改下面 `ATR_RUNTIME_BIN` 那一行（或部署时给 `--runtime`）。
#
# ⚠️ 它**不是** `packages/*/dist` 那样的构建产物，所以由部署脚本单独安装：
#   在此之前这个文件只存在于目标机磁盘上（仓库里没有），
#   于是「线上跑 Node 还是 Bun」是一条**只存在于一台机器上的事实** ——
#   谁重建机器、或谁手工重写一遍这个文件，就会静默退回 Node22，且没有任何地方会报错。
#
# ⚠️ 换运行时是一次**独立于产物切换**的改动。`scripts/deploy-server.mjs` 现在把它一起管了，
#   但历史备份（`.deploy-backup-*`）里存的是当时的启动包装，回滚部署会连它一起回滚 ——
#   这正是我们要的。
ATR_RUNTIME_BIN="/usr/local/bin/bun"

set -uo pipefail

# 凭证与监听配置（ATR_HOST / ATR_PORT / ATR_MYSQL_URL / ATR_CAPTCHA_HMAC_KEY …）。
# 这个文件**不入库**，也不由部署脚本改写 —— 部署脚本只读取它的 ATR_PORT 做健检。
ENV_FILE="${ATR_ENV_FILE:-/root/.atr/portal.env}"
[ -f "$ENV_FILE" ] || { echo "找不到环境文件：$ENV_FILE" >&2; exit 1; }

set -a
. "$ENV_FILE"
set +a

# ★ 从脚本自身位置推导项目根，而不是写死 /data/ai-token-report：
#   部署脚本支持 `--remote-root`，写死的路径会让它在另一个根下报一句含糊的
#   「找不到模块」，而那时 pm2 的状态仍然是 online。
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

MAIN="$ROOT/packages/server/dist/main.mjs"
[ -f "$MAIN" ] || { echo "找不到服务端产物：$MAIN" >&2; exit 1; }

# ⚠️ `set -u`：ATR_HOST / ATR_PORT 缺失时必须**当场失败**，不能沿用服务端内置默认值。
#   否则配置写漏一个变量，服务会安静地监听到另一个端口上，
#   而健检、nginx 反代、PM2 状态看起来全都正常。
exec "$ATR_RUNTIME_BIN" "$MAIN" \
  --host "$ATR_HOST" --port "$ATR_PORT" \
  --static "$ROOT/packages/web-portal/dist"
