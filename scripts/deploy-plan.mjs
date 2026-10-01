/**
 * 部门服务端部署的**纯逻辑**：可选运行时、启动包装的渲染、以及产物与运行时的匹配断言。
 *
 * ## 为什么单独一个文件（而不是塞在 `deploy-server.mjs` 里）
 *
 * `deploy-server.mjs` 是**用 `node` 直接跑**的入口（`node scripts/deploy-server.mjs`，
 * 不经 bun —— 见 docs/服务器部署.md §六），所以它是 `.mjs`，没法被 `.ts` 测试直接 import，
 * 而它自己在被 import 的那一刻就会开始跑整个部署流程。
 * ⇒ 危险的部分（生成远端 bash、决定线上跑哪个运行时）必须抽出来，
 *   才能被 `packages/server/test/deploy-plan.test.ts` 钉住。
 *   这与 `scripts/release-plan.ts` 是同一套办法（那边由 `release-plan.test.ts` 兜住）。
 *
 * ## 它解决的问题
 *
 * 「线上用 Node22 还是 Bun 跑」此前是**只存在于目标机磁盘上的一个文件**里的一行字：
 * 仓库里既没有那个文件，`deploy-server.mjs` 也一个字都不提运行时。
 * 后果是双重的 ——
 *   ① 谁重建机器 / 手工重写一遍启动包装，就静默退回 Node22，没有任何地方会报错；
 *   ② 更糟的是**顺序**：产物里若还没有 `planBunMysqlAuth()` 那个 TLS 修复就切 Bun，
 *      线上 `atr_user`（32 字符口令）会直接撞 `errno 1045` 连不上库
 *      （oven-sh/bun#26195）。实测 2026-10-01：切换前线上那份 main.mjs 里
 *      该标识符命中数为 **0** —— 先切运行时就是起不来。
 *
 * 所以这里把两件事都变成**可断言的仓库事实**：运行时是显式参数，
 * 产物配不配得上这个运行时由 {@link assertBundleSupportsRuntime} 在**上传之前**判死。
 */

/**
 * 目标机上可选的运行时。
 *
 * ⚠️ 路径是**目标机**（117.72.173.21）的约定，与本机开发环境无关。
 *   两台机器上的 bun 都是 `/usr/local/bin/bun`（1.4.2），node 是 `/usr/local/node22/bin/node`（v22.21.1）。
 *   🚨 别把它们改成 `command -v bun` 这类动态探测：启动包装是在 pm2 里跑的，
 *      它的 PATH 与交互式登录 shell 不同，「探测得到」和「pm2 能 exec 到」是两件事。
 */
export const RUNTIMES = {
  bun: { bin: '/usr/local/bin/bun', label: 'Bun', mysqlTlsFix: true },
  node: { bin: '/usr/local/node22/bin/node', label: 'Node 22', mysqlTlsFix: false },
}

/** 启动包装在仓库里的位置（相对仓库根）。它由部署脚本安装到目标机的同一相对路径下。 */
export const START_SCRIPT_REPO_PATH = 'deploy/atr-server-start.sh'

/**
 * 启动包装里决定运行时的**唯一**那一行。
 *
 * 🚨 必须锚定行首。写成不带 `^` 的模式会连带匹配到注释里对它的说明，
 *   于是「改运行时」实际改掉的是一行注释，而启动包装照旧跑旧运行时 ——
 *   这种失败看起来完全正常（服务起来了、健康检查也过）。
 */
export const RUNTIME_LINE_PATTERN = /^ATR_RUNTIME_BIN=.*$/m

/**
 * Bun 连 MySQL 长口令的 TLS 修复标识（`core/src/db/mysql.ts` 的 `planBunMysqlAuth()`）。
 *
 * 它是**产物新鲜度**的判据：这个修复进了代码之后，任何一次正常构建的 `main.mjs`
 * 里都会有这个标识符。没有它 ⇒ 这份产物早于该修复 ⇒ 在 Bun 上连不上线上那种
 * 长口令的 `caching_sha2_password` 账号。
 */
export const BUN_MYSQL_TLS_MARKER = 'planBunMysqlAuth'

/**
 * 解析运行时名。
 * @param {string} name `bun` | `node`
 * @returns {{ name: string, bin: string, label: string, mysqlTlsFix: boolean }}
 */
export function resolveRuntime(name) {
  const runtime = RUNTIMES[name]
  if (!runtime) throw new Error(`未知运行时：${name}（可选：${Object.keys(RUNTIMES).join(' / ')}）`)
  return { name, ...runtime }
}

/**
 * 把仓库里的启动包装渲染成「跑指定运行时」的那一份。
 *
 * 只改 `ATR_RUNTIME_BIN=` 那一行，其余字节原样保留 —— 这样渲染结果与仓库里那一份
 * 的差异恰好就是运行时，`diff` 出来的东西永远可读。
 *
 * @param {string} template 仓库里 `deploy/atr-server-start.sh` 的全文
 * @param {string} runtimeName `bun` | `node`
 * @returns {string} 要上传安装的启动包装全文
 */
export function renderStartScript(template, runtimeName) {
  const runtime = resolveRuntime(runtimeName)
  if (!RUNTIME_LINE_PATTERN.test(template)) {
    throw new Error(
      `启动包装里找不到 \`ATR_RUNTIME_BIN=\` 那一行（${START_SCRIPT_REPO_PATH}）。` +
      '它是部署脚本改写运行时的唯一落点，缺了它就没法保证线上跑的是哪个运行时。',
    )
  }
  // 用函数式替换：`$&` / `$1` 这类替换串里的特殊记号不会去解释二进制路径。
  return template.replace(RUNTIME_LINE_PATTERN, () => `ATR_RUNTIME_BIN="${runtime.bin}"`)
}

/**
 * 产物配不配得上这个运行时 —— **上传之前**就要判死。
 *
 * @param {string} bundleText `packages/server/dist/main.mjs` 的全文
 * @param {string} runtimeName `bun` | `node`
 */
export function assertBundleSupportsRuntime(bundleText, runtimeName) {
  const runtime = resolveRuntime(runtimeName)
  if (!runtime.mysqlTlsFix) return
  if (bundleText.includes(BUN_MYSQL_TLS_MARKER)) return
  throw new Error(
    `产物里没有 \`${BUN_MYSQL_TLS_MARKER}\`，不能用 Bun 运行时发布：\n` +
    '  线上上报库账号的口令 ≥20 字节，Bun 1.4.2 在非 TLS 连接下对 caching_sha2_password\n' +
    '  会 errno 1045（oven-sh/bun#26195），而该修复正是为这种连接自动启用 TLS。\n' +
    '  ⇒ 这份 main.mjs 早于修复，或者构建没跑完。先重新构建（bun run --filter \'@ai-token-report/server\' build:node）。',
  )
}

/**
 * 生成在目标机上执行的部署脚本。
 *
 * ⚠️ 本模板里的 shell 变量一律写 `$VAR`，**不要写 `${VAR}`** ——
 * 脚本用 JS 模板字符串拼装，`${` 会被 JS 抢先求值，是最容易埋进去的一类 bug。
 * （`${...}` 在本文件里出现的每一处都应当是 JS 插值；测试里有一条断言钉住这件事。）
 *
 * ★ 切换与回滚是**一个原子操作**：先备份（产物 + 启动包装），再就位，最后重启健检；
 *   任一步失败都把两样一起还原并重启，不留「切了一半」的状态。
 * ★ 运行时要额外断言进程真的 exec 在指定二进制上 —— 启动包装装错了、或 pm2 没重读，
 *   表现都是「服务健康但跑的是另一个运行时」，那正是本次要根治的东西。
 */
export function renderRemoteScript({ mode, stamp, portalBase, remoteRoot, pm2Name, keepOldAssets, runtimeName, runtimeBin, startScriptUpload }) {
  const stage = `/tmp/atr-deploy-${stamp}`
  const assetPrefix = `${portalBase}assets/`
  return `#!/bin/bash
# 由 scripts/deploy-server.mjs 生成并在目标服务器执行（模式：${mode}，运行时：${runtimeName}）。
# 只看两件事：产物是否完整、切换后服务是否真的活着；失败必须能回到原状。
set -uo pipefail

ROOT=${remoteRoot}
PM2_NAME=${pm2Name}
RUNTIME_BIN="${runtimeBin}"
START_SCRIPT=$ROOT/deploy/atr-server-start.sh
START_SRC=${startScriptUpload}
WORK=${stage}
STAGE=$WORK/stage
BACKUP=$ROOT/.deploy-backup-${stamp}
KEEP_OLD_ASSETS=${keepOldAssets ? 1 : 0}
SERVER_DIST=$ROOT/packages/server/dist
PORTAL_DIST=$ROOT/packages/web-portal/dist

log() { echo "[remote] $*"; }
fail() { log "ERROR: $*"; echo "ATR_DEPLOY_RESULT=failed"; exit 1; }

mkdir -p "$STAGE/server-dist" "$STAGE/portal-dist"
tar -xzf ${stage}-server.tgz -C "$STAGE/server-dist" || fail "server tgz 解包失败"
tar -xzf ${stage}-portal.tgz -C "$STAGE/portal-dist" || fail "portal tgz 解包失败"
[ -f "$START_SRC" ] || fail "启动包装没上传到 $START_SRC"

# 产物完整性：缺 main.mjs 直接起不来，宁可拒绝部署也不要把服务挂在半路
[ -f "$STAGE/server-dist/main.mjs" ] || fail "staging 缺 main.mjs"
[ -f "$STAGE/server-dist/migrate-db.mjs" ] || fail "staging 缺 migrate-db.mjs"
[ -f "$STAGE/server-dist/import-credentials.mjs" ] || fail "staging 缺 import-credentials.mjs"
[ -f "$STAGE/portal-dist/index.html" ] || fail "staging 缺 index.html"
grep -q "${assetPrefix}" "$STAGE/portal-dist/index.html" || fail "index.html 未带子路径前缀 ${assetPrefix}，部署后必然白屏"

# 启动包装本身也要校验：它是运行时唯一的落点，语法错 = 服务起不来
bash -n "$START_SRC" || fail "启动包装语法检查未通过"
grep -q "^ATR_RUNTIME_BIN=" "$START_SRC" || fail "启动包装里没有 ATR_RUNTIME_BIN 那一行"

log "server 产物：$(du -sh "$STAGE/server-dist" | cut -f1) / $(ls "$STAGE/server-dist" | wc -l) 个文件"
log "portal 产物：$(du -sh "$STAGE/portal-dist" | cut -f1) / assets $(ls "$STAGE/portal-dist/assets" | wc -l) 个文件"

if [ "${mode}" = "preflight" ]; then
  log "preflight 完成：产物与启动包装已上传并通过校验，未触碰现网文件、未重启服务"
  rm -rf "$WORK"; rm -f "$WORK"-server.tgz "$WORK"-portal.tgz "$START_SRC"
  echo "ATR_DEPLOY_RESULT=preflight-ok"
  exit 0
fi

# ---- 切换：先备份，再就位 ----
mkdir -p "$BACKUP" || fail "创建备份目录失败"
cp -a "$SERVER_DIST" "$BACKUP/server-dist" || fail "备份 server dist 失败"
cp -a "$PORTAL_DIST" "$BACKUP/portal-dist" || fail "备份 portal dist 失败"
log "已备份到 $BACKUP"

# ★ 运行时：用**仓库里那一份**覆盖安装，原文件先备份（回滚时还原）。
#   以前这一步是手工 SSH 改的，改坏了没有第二份。
mkdir -p "$ROOT/deploy" || fail "创建 deploy 目录失败"
if [ -f "$START_SCRIPT" ]; then
  cp -a "$START_SCRIPT" "$BACKUP/atr-server-start.sh" || fail "备份启动包装失败"
  log "已备份原启动包装"
else
  log "线上原本没有启动包装，本次为首次安装"
fi
cp -f "$START_SRC" "$START_SCRIPT" || fail "安装启动包装失败"
chmod 755 "$START_SCRIPT"
log "启动包装已就位（运行时 $RUNTIME_BIN）"

rm -rf "$SERVER_DIST" && mkdir -p "$SERVER_DIST" || fail "重建 server dist 目录失败"
cp -a "$STAGE/server-dist/." "$SERVER_DIST/" || fail "写入 server 产物失败"

# portal：新 assets 是内容哈希命名，先就位再换 index.html，最后才清旧文件，避免切换瞬间 404
mkdir -p "$PORTAL_DIST/assets"
cp -a "$STAGE/portal-dist/assets/." "$PORTAL_DIST/assets/" || fail "写入 portal assets 失败"
cp -f "$STAGE/portal-dist/index.html" "$PORTAL_DIST/index.html" || fail "写入 index.html 失败"
[ -f "$STAGE/portal-dist/favicon.svg" ] && cp -f "$STAGE/portal-dist/favicon.svg" "$PORTAL_DIST/favicon.svg"
if [ "$KEEP_OLD_ASSETS" != "1" ]; then
  ls "$STAGE/portal-dist/assets" > /tmp/atr-keep-assets.txt
  removed=0
  for f in "$PORTAL_DIST"/assets/*; do
    [ -e "$f" ] || continue
    if ! grep -qxF "$(basename "$f")" /tmp/atr-keep-assets.txt; then rm -f "$f"; removed=$((removed + 1)); fi
  done
  rm -f /tmp/atr-keep-assets.txt
  log "清理历史 assets：$removed 个"
fi

# ---- 重启 + 健康检查 ----
export PATH=/usr/local/bin:$PATH
set -a; . /root/.atr/portal.env; set +a
OLD_PID=$(pm2 pid "$PM2_NAME" 2>/dev/null | tr -d '[:space:]')
log "重启 $PM2_NAME（旧 pid $OLD_PID）"
pm2 restart "$PM2_NAME" >/dev/null 2>&1 || true

# 回滚：产物与启动包装**一起**还原。只还原产物会让「运行时已经换掉了」
# 留在原地，而这正是这次要根治的那类半成品状态。
rollback() {
  log "$1，开始回滚"
  rm -rf "$SERVER_DIST" && cp -a "$BACKUP/server-dist" "$SERVER_DIST"
  rm -rf "$PORTAL_DIST" && cp -a "$BACKUP/portal-dist" "$PORTAL_DIST"
  if [ -f "$BACKUP/atr-server-start.sh" ]; then
    cp -a "$BACKUP/atr-server-start.sh" "$START_SCRIPT"
  else
    rm -f "$START_SCRIPT"
  fi
  pm2 restart "$PM2_NAME" >/dev/null 2>&1 || true
  for i in $(seq 1 20); do
    sleep 1
    curl -sf -m 3 "http://127.0.0.1:$ATR_PORT/api/health" >/dev/null 2>&1 && break
  done
  log "回滚后状态：$(curl -sf -m 3 "http://127.0.0.1:$ATR_PORT/api/health" 2>/dev/null || echo '仍不可用')"
  log "最近日志："
  pm2 logs "$PM2_NAME" --lines 15 --nostream --no-color 2>&1 | tail -20
}

health=""
for i in $(seq 1 30); do
  sleep 1
  if health=$(curl -sf -m 3 "http://127.0.0.1:$ATR_PORT/api/health" 2>/dev/null); then break; fi
  health=""
done

if [ -z "$health" ]; then
  rollback "健康检查 30 秒未通过"
  echo "ATR_DEPLOY_RESULT=rolled-back"
  exit 2
fi

# ---- 运行时断言：进程真的 exec 在我们指定的那个二进制上吗 ----
# 🚨 只有「两边都读到了、且不同」才判失败。/proc/<pid>/exe 读不到
#   （权限、进程刚好退出）时判 unknown —— 绝不因为一次探测失败
#   去回滚一个已经健康的部署。
NEW_PID=$(pm2 pid "$PM2_NAME" 2>/dev/null | tr -d '[:space:]')
RUNTIME_EXPECTED=$(readlink -f "$RUNTIME_BIN" 2>/dev/null || echo "")
RUNTIME_ACTUAL=$(readlink -f "/proc/$NEW_PID/exe" 2>/dev/null || echo "")
log "运行时：期望 $RUNTIME_EXPECTED / 实际 $RUNTIME_ACTUAL"

if [ -n "$RUNTIME_EXPECTED" ] && [ -n "$RUNTIME_ACTUAL" ] && [ "$RUNTIME_EXPECTED" != "$RUNTIME_ACTUAL" ]; then
  rollback "服务健康但进程跑的不是 $RUNTIME_BIN"
  echo "ATR_DEPLOY_RUNTIME_EXPECTED=$RUNTIME_EXPECTED"
  echo "ATR_DEPLOY_RUNTIME_ACTUAL=$RUNTIME_ACTUAL"
  echo "ATR_DEPLOY_RESULT=runtime-mismatch"
  exit 3
fi

log "服务已就绪：$health"
rm -rf "$WORK"; rm -f "$WORK"-server.tgz "$WORK"-portal.tgz "$START_SRC"
echo "ATR_DEPLOY_HEALTH=$health"
echo "ATR_DEPLOY_OLD_PID=$OLD_PID"
echo "ATR_DEPLOY_NEW_PID=$NEW_PID"
echo "ATR_DEPLOY_BACKUP=$BACKUP"
echo "ATR_DEPLOY_RUNTIME_EXPECTED=$RUNTIME_EXPECTED"
echo "ATR_DEPLOY_RUNTIME_ACTUAL=$RUNTIME_ACTUAL"
echo "ATR_DEPLOY_RESULT=ok"
`
}
