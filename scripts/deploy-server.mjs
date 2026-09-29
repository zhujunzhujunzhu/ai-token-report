#!/usr/bin/env node
/**
 * 部门服务端部署入口（Node 脚本，`node scripts/deploy-server.mjs` 直接跑，不依赖 bun 做入口）。
 *
 * 这条链路解决的是「本地构建 → 上传产物 → 服务器切换 → 重启 → 健检」这一串手工步骤。
 * 它与 `scripts/release.ts`（npm 公开发布）是**两件不同的事**：
 *   前者把产物送上 117.72.173.21 的 /data/ai-token-report，
 *   后者把 tarball 发到 registry.npmjs.org。两者共用不了验证，不要互相替代。
 *
 * ★ 默认零副作用：不带参数只做本地构建 + 打包 + 打印计划，**不连服务器**。
 *   真上传是 `--preflight`（只上传校验，不切换），真部署是 `--apply`。
 *
 * ★ 只覆盖 packages/server/dist 与 packages/web-portal/dist，绝不碰：
 *   - node_modules：产物 external 了 `mysql2/promise`，靠 packages/server/node_modules 解析；
 *   - deploy/atr-server-start.sh：服务器的 PM2 启动包装，仓库里没有这个文件；
 *   - /root/.atr/portal.env：凭证与监听配置。
 *
 * ⚠️ 子路径部署必须带 DSH_PORTAL_BASE（本站为 `/ai-token/`）。
 *   忘了带会构建出绝对路径产物，页面**立即变白且服务端零报错** —— 所以本地构建后
 *   直接断言 index.html 里的资源前缀，把这条人工约定钉死在脚本里。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------- 参数解析：拼错参数不能退回成真实部署 ----------
const DEFAULTS = { portalBase: '/ai-token/', remoteRoot: '/data/ai-token-report', pm2Name: 'ai-token-server' }

/**
 * 读取仓库根 `.env` 的 `host` / `password`（服务器凭据的既有存放处）。
 * ⚠️ 只取值不打印：这份文件的 password 是生产 root 密码，任何日志里都不能出现它。
 */
function loadDotEnv() {
  const file = join(root, '.env')
  const values = {}
  if (!existsSync(file)) return values
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const matched = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/)
    if (matched) values[matched[1]] = matched[2].replace(/^["']|["']$/g, '')
  }
  return values
}

function parseArgs(argv) {
  const dotenv = loadDotEnv()
  const options = {
    mode: 'dry-run', skipVerify: false, fullVerify: false, keepOldAssets: false,
    host: process.env['ATR_DEPLOY_HOST'] ?? dotenv['host'] ?? '', user: process.env['ATR_DEPLOY_USER'] ?? 'root',
    password: process.env['ATR_DEPLOY_PASSWORD'] ?? dotenv['password'] ?? '', hostkey: process.env['ATR_DEPLOY_HOSTKEY'] ?? '',
    portalBase: process.env['ATR_DEPLOY_PORTAL_BASE'] ?? DEFAULTS.portalBase,
    remoteRoot: DEFAULTS.remoteRoot, pm2Name: DEFAULTS.pm2Name,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--apply') options.mode = 'apply'
    else if (arg === '--preflight') options.mode = 'preflight'
    else if (arg === '--dry-run') options.mode = 'dry-run'
    else if (arg === '--skip-verify') options.skipVerify = true
    else if (arg === '--full-verify') options.fullVerify = true
    else if (arg === '--keep-old-assets') options.keepOldAssets = true
    else if (arg === '--server') options.host = argv[++i] ?? ''
    else if (arg === '--user') options.user = argv[++i] ?? ''
    else if (arg === '--hostkey') options.hostkey = argv[++i] ?? ''
    else if (arg === '--portal-base') options.portalBase = argv[++i] ?? ''
    else if (arg === '--remote-root') options.remoteRoot = argv[++i] ?? ''
    else throw new Error(`未知参数：${arg}`)
  }
  if (!options.portalBase.endsWith('/')) throw new Error(`--portal-base 必须以 / 结尾：${options.portalBase}`)
  if (options.skipVerify && options.fullVerify) throw new Error('--skip-verify 与 --full-verify 不能同时使用')
  return options
}

// ---------- 报告与日志 ----------
const options = parseArgs(process.argv.slice(2))
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const output = join(root, '.artifacts', 'deploys', stamp)
mkdirSync(output, { recursive: true })
const report = {
  status: 'running', mode: options.mode, startedAt: new Date().toISOString(),
  portalBase: options.portalBase, remoteRoot: options.remoteRoot, host: options.host || '(待解析)',
  steps: [], local: {}, artifacts: [], remote: {}, rollback: '未触发',
}
const reportPath = join(output, 'report.json')
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')

/** 同时落盘与透传的子进程执行；构建与验证的输出要能在终端实时看到。 */
function runStep(label, command, args, extraEnv = {}) {
  const index = String(report.steps.length + 1).padStart(2, '0')
  const logPath = join(output, `${index}-${label}.log`)
  console.log(`\n[${index}] ${label}\n    $ ${command} ${args.join(' ')}`)
  const started = Date.now()
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd: root, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    })
    writeFileSync(logPath, '')
    const pipe = (chunk) => { process.stdout.write(chunk); appendFileSync(logPath, chunk) }
    child.stdout.on('data', pipe)
    child.stderr.on('data', pipe)
    child.on('error', fail)
    child.on('close', (code) => {
      const milliseconds = Date.now() - started
      report.steps.push({ label, command, args, code, milliseconds, log: logPath })
      save()
      if (code !== 0) return fail(new Error(`${label} 失败（退出码 ${code}）；日志 ${logPath}`))
      console.log(`    PASS (${(milliseconds / 1000).toFixed(1)}s)`)
      done(undefined)
    })
  })
}

// ---------- 本机工具链 ----------
function which(names) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const directories = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)
  const fallbacks = process.platform === 'win32' ? ['C:\\Program Files\\PuTTY'] : []
  for (const directory of [...directories, ...fallbacks]) {
    for (const name of names) {
      for (const extension of extensions) {
        const candidate = join(directory, name + extension)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return null
}

/**
 * 从 ~/.ssh/known_hosts 取主机指纹，供 plink/pscp 的 -hostkey 使用。
 * ⚠️ 少了它 plink 会停下来问 yes/no；`-batch` 下则直接拒绝连接，表现为「密码对但连不上」。
 */
function knownHostFingerprint(host, sshKeygen) {
  const knownHosts = join(homedir(), '.ssh', 'known_hosts')
  if (!existsSync(knownHosts) || !sshKeygen) return ''
  const line = readFileSync(knownHosts, 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${host} `) || l.startsWith(`${host},`))
  if (!line) return ''
  const scratch = join(tmpdir(), `atr-known-host-${process.pid}`)
  writeFileSync(scratch, `${line}\n`)
  const result = spawnSync(sshKeygen, ['-lf', scratch], { encoding: 'utf8' })
  rmSync(scratch, { force: true })
  return result.stdout.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0] ?? ''
}

/**
 * 传输通道二选一：优先免密 OpenSSH，退到 PuTTY 的 plink/pscp（密码认证）。
 * ⚠️ OpenSSH 的客户端**不接受命令行密码**，所以密码那条路只能用 PuTTY 工具。
 */
function resolveTransport(options) {
  const ssh = which(['ssh'])
  if (ssh && options.host) {
    const probe = spawnSync(ssh, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', `${options.user}@${options.host}`, 'true'], { encoding: 'utf8' })
    if (probe.status === 0) return { kind: 'openssh', ssh, scp: which(['scp']), hostkey: '' }
  }
  const plink = which(['plink'])
  const pscp = which(['pscp'])
  if (!plink || !pscp) {
    throw new Error('既没有免密 ssh，也没找到 plink/pscp；请配置 SSH 公钥，或安装 PuTTY 工具集')
  }
  if (!options.password) {
    throw new Error('需要密码认证，但 .env 的 password 与 ATR_DEPLOY_PASSWORD 都为空')
  }
  const sshKeygen = which(['ssh-keygen'])
  const hostkey = options.hostkey || knownHostFingerprint(options.host, sshKeygen)
  if (!hostkey) throw new Error(`无法确定 ${options.host} 的主机指纹；请显式传 --hostkey SHA256:...`)
  return { kind: 'putty', plink, pscp, hostkey }
}

/** 统一的远程执行：远程脚本走文件通道（plink -m），避免把引号与 dollar 拼进命令行。 */
function remoteExec(transport, options, scriptPath) {
  const target = `${options.user}@${options.host}`
  if (transport.kind === 'openssh') return spawnSync(transport.ssh, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', target, 'bash -s'], { input: readFileSync(scriptPath), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return spawnSync(transport.plink, ['-ssh', '-batch', '-hostkey', transport.hostkey, '-pw', options.password, '-m', scriptPath, target], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

function remoteUpload(transport, options, files, remoteDirectory) {
  const target = `${options.user}@${options.host}`
  const args = transport.kind === 'openssh'
    ? ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...files, `${target}:${remoteDirectory}`]
    : ['-batch', '-hostkey', transport.hostkey, '-pw', options.password, ...files, `${target}:${remoteDirectory}`]
  const result = spawnSync(transport.kind === 'openssh' ? transport.scp : transport.pscp, args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`上传失败：${result.stderr || result.stdout}`)
  return result.stdout
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

// ---------- 远程脚本（在目标机上执行）----------
/**
 * ⚠️ 本模板里的 shell 变量一律写 `$VAR`，**不要写 `${VAR}`** ——
 * 脚本用 JS 模板字符串拼装，`${` 会被 JS 抢先求值，是最容易埋进去的一类 bug。
 */
function renderRemoteScript({ mode, stamp, portalBase, remoteRoot, pm2Name, keepOldAssets }) {
  const stage = `/tmp/atr-deploy-${stamp}`
  const assetPrefix = `${portalBase}assets/`
  return `#!/bin/bash
# 由 scripts/deploy-server.mjs 生成并在目标服务器执行（模式：${mode}）。
# 只看两件事：产物是否完整、切换后服务是否真的活着；失败必须能回到原状。
set -uo pipefail

ROOT=${remoteRoot}
PM2_NAME=${pm2Name}
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

# 产物完整性：缺 main.mjs 直接起不来，宁可拒绝部署也不要把服务挂在半路
[ -f "$STAGE/server-dist/main.mjs" ] || fail "staging 缺 main.mjs"
[ -f "$STAGE/server-dist/migrate-db.mjs" ] || fail "staging 缺 migrate-db.mjs"
[ -f "$STAGE/server-dist/import-credentials.mjs" ] || fail "staging 缺 import-credentials.mjs"
[ -f "$STAGE/portal-dist/index.html" ] || fail "staging 缺 index.html"
grep -q "${assetPrefix}" "$STAGE/portal-dist/index.html" || fail "index.html 未带子路径前缀 ${assetPrefix}，部署后必然白屏"

log "server 产物：$(du -sh "$STAGE/server-dist" | cut -f1) / $(ls "$STAGE/server-dist" | wc -l) 个文件"
log "portal 产物：$(du -sh "$STAGE/portal-dist" | cut -f1) / assets $(ls "$STAGE/portal-dist/assets" | wc -l) 个文件"

if [ "${mode}" = "preflight" ]; then
  log "preflight 完成：产物已上传并通过校验，未触碰现网文件、未重启服务"
  rm -rf "$WORK"; rm -f "$WORK"-server.tgz "$WORK"-portal.tgz
  echo "ATR_DEPLOY_RESULT=preflight-ok"
  exit 0
fi

# ---- 切换：先备份，再就位 ----
mkdir -p "$BACKUP" || fail "创建备份目录失败"
cp -a "$SERVER_DIST" "$BACKUP/server-dist" || fail "备份 server dist 失败"
cp -a "$PORTAL_DIST" "$BACKUP/portal-dist" || fail "备份 portal dist 失败"
log "已备份到 $BACKUP"

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

health=""
for i in $(seq 1 30); do
  sleep 1
  if health=$(curl -sf -m 3 "http://127.0.0.1:$ATR_PORT/api/health" 2>/dev/null); then break; fi
  health=""
done

if [ -z "$health" ]; then
  log "健康检查 30 秒未通过，开始回滚"
  rm -rf "$SERVER_DIST" && cp -a "$BACKUP/server-dist" "$SERVER_DIST"
  rm -rf "$PORTAL_DIST" && cp -a "$BACKUP/portal-dist" "$PORTAL_DIST"
  pm2 restart "$PM2_NAME" >/dev/null 2>&1 || true
  for i in $(seq 1 20); do
    sleep 1
    curl -sf -m 3 "http://127.0.0.1:$ATR_PORT/api/health" >/dev/null 2>&1 && break
  done
  log "回滚后状态：$(curl -sf -m 3 "http://127.0.0.1:$ATR_PORT/api/health" 2>/dev/null || echo '仍不可用')"
  log "最近日志："
  pm2 logs "$PM2_NAME" --lines 15 --nostream --no-color 2>&1 | tail -20
  echo "ATR_DEPLOY_RESULT=rolled-back"
  exit 2
fi

NEW_PID=$(pm2 pid "$PM2_NAME" 2>/dev/null | tr -d '[:space:]')
log "服务已就绪：$health"
rm -rf "$WORK"; rm -f "$WORK"-server.tgz "$WORK"-portal.tgz
echo "ATR_DEPLOY_HEALTH=$health"
echo "ATR_DEPLOY_OLD_PID=$OLD_PID"
echo "ATR_DEPLOY_NEW_PID=$NEW_PID"
echo "ATR_DEPLOY_BACKUP=$BACKUP"
echo "ATR_DEPLOY_RESULT=ok"
`
}

// ---------- 公网校验：这是唯一能抓住「白屏」的环节 ----------
/**
 * 经 nginx 抓首页与其入口资源，断言 MIME。
 * 子路径配错的经典症状是 assets 被站点根的其他应用接走，回 text/html，
 * 浏览器按模块 MIME 校验拒绝执行 ⇒ 页面全白，而**服务端日志里一句错都没有**。
 */
/**
 * 本地代码期望的上报库 schema 版本；与服务器实际版本不一致意味着必须先显式迁移。
 *
 * 🚨 不要写死某个具体版本的文件名。`PORTAL_SCHEMA_VERSION` 会随 schema 版本**搬家**
 *   （v4→v5 时就整体挪进了 `portal-schema-v5.ts`），写死 `portal-schema-v4.ts`
 *   会让这里静默 return null，而调用点原来的 `expected !== null` 判断
 *   会把「读不到」变成「跳过比对」—— 于是部署脚本再也不会提示版本不一致，
 *   表现却是「部署成功、全员数据进不来」。
 *   所以这里扫描所有 `portal-schema-v*.ts`，取真正导出该常量的那一个。
 */
function localPortalSchemaVersion() {
  const dir = join(root, 'packages', 'core', 'src', 'db')
  if (!existsSync(dir)) return null
  for (const name of readdirSync(dir).filter((entry) => /^portal-schema-v\d+\.ts$/.test(entry))) {
    const matched = readFileSync(join(dir, name), 'utf8').match(/export\s+const\s+PORTAL_SCHEMA_VERSION\s*=\s*(\d+)/)
    if (matched) return Number(matched[1])
  }
  return null
}

async function verifyPublic(host, portalBase) {
  const base = `http://${host}${portalBase}`
  const health = await fetch(`${base}health`, { signal: AbortSignal.timeout(8000) })
  const healthBody = await health.text()
  report.remote.publicHealth = { status: health.status, body: healthBody.slice(0, 400) }
  if (health.status !== 200 || !healthBody.includes('"ok":true')) throw new Error(`公网 health 异常：${health.status} ${healthBody.slice(0, 200)}`)

  // ⚠️ 上报库 schema 变更绝不自动迁移：版本对不上时服务端会拒绝业务写入，
  // 而 health 可能仍然 ok —— 不在这里点名，就是「部署成功但全员数据进不来」。
  const deployed = Number(healthBody.match(/"schema_version"\s*:\s*(\d+)/)?.[1] ?? NaN)
  const expected = localPortalSchemaVersion()
  report.remote.schemaVersion = { deployed, expected }
  // ★ 「读不到期望版本」必须显式说出来：静默跳过会让这条唯一的版本护栏消失，
  //   而部署者看到的仍是一份全绿的报告。
  if (expected === null) {
    console.warn('⚠️ 读不到本地代码里的上报库 schema 版本常量，本次跳过版本比对（部署脚本自身可能已过期）')
  } else if (deployed !== expected) {
    console.warn(`⚠️ 上报库 schema 版本不一致：服务器 ${deployed}，本地代码期望 ${expected}`)
    console.warn(`   服务端已启动但可能拒绝写入。先跑 dist/migrate-db.mjs 显式迁移（见 docs/数据库部署与迁移.md）`)
  }

  const page = await fetch(base, { signal: AbortSignal.timeout(8000) })
  const html = await page.text()
  report.remote.publicPage = { status: page.status, bytes: Buffer.byteLength(html) }
  if (page.status !== 200) throw new Error(`公网首页返回 ${page.status}`)

  const asset = html.match(new RegExp(`${portalBase.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}assets/[^"']+\\.js`))?.[0]
  if (!asset) throw new Error(`首页里找不到 ${portalBase}assets/*.js，静态资源前缀可能不对`)
  const assetResponse = await fetch(`http://${host}${asset}`, { signal: AbortSignal.timeout(15000) })
  const contentType = assetResponse.headers.get('content-type') ?? ''
  report.remote.publicAsset = { asset, status: assetResponse.status, contentType, bytes: Number(assetResponse.headers.get('content-length') ?? 0) }
  if (assetResponse.status !== 200 || !contentType.includes('javascript')) {
    throw new Error(`入口 JS 经 nginx 异常：${asset} → ${assetResponse.status} ${contentType}（MIME 不对就是白屏）`)
  }
  return report.remote.publicAsset
}

// ---------- 主流程 ----------
try {
  // 本地阶段：构建与产物断言
  if (!options.skipVerify) {
    if (options.fullVerify) {
      await runStep('全仓测试', 'bun', ['test'])
      await runStep('全仓类型检查', 'bun', ['run', 'typecheck'])
    } else {
      await runStep('server 类型检查', 'bun', ['run', '--filter', '@ai-token-report/server', 'typecheck'])
      await runStep('server 测试', 'bun', ['test', 'packages/server'])
      await runStep('web-portal 类型检查', 'bun', ['run', '--filter', '@ai-token-report/web-portal', 'typecheck'])
    }
  }
  await runStep('构建服务端 Node 产物', 'bun', ['run', '--filter', '@ai-token-report/server', 'build:node'])
  // ★ 子路径前缀必须进构建环境，否则产物写绝对路径，页面白屏且服务端不报错
  await runStep('构建部门看板产物', 'bun', ['run', 'build:portal'], { DSH_PORTAL_BASE: options.portalBase })

  const serverDist = join(root, 'packages', 'server', 'dist')
  const portalDist = join(root, 'packages', 'web-portal', 'dist')
  for (const required of ['main.mjs', 'migrate-db.mjs', 'import-credentials.mjs']) {
    if (!existsSync(join(serverDist, required))) throw new Error(`服务端产物缺 ${required}（${serverDist}）`)
  }
  const indexHtml = readFileSync(join(portalDist, 'index.html'), 'utf8')
  if (!indexHtml.includes(`${options.portalBase}assets/`)) {
    throw new Error(`看板产物未带子路径前缀 ${options.portalBase}assets/；DSH_PORTAL_BASE 没生效，部署后会白屏`)
  }
  report.local.serverDist = { files: readFileSync(join(serverDist, 'main.mjs')).length }
  report.local.portalIndexHtml = { bytes: Buffer.byteLength(indexHtml) }
  console.log(`\n产物自检通过：main.mjs ${(report.local.serverDist.files / 1024).toFixed(0)} KB，index.html 带前缀 ${options.portalBase}`)

  // 打包：一次一个 tar，传的与解的就是同一份字节
  // ★ 文件名自带 stamp：pscp 不能重命名，本地就按远端期望的名字产出，省掉一次远程 mv
  const serverTarball = join(output, `atr-deploy-${stamp}-server.tgz`)
  const portalTarball = join(output, `atr-deploy-${stamp}-portal.tgz`)
  for (const [label, source, tarball] of [['server', serverDist, serverTarball], ['portal', portalDist, portalTarball]]) {
    await runStep(`打包 ${label} 产物`, 'tar', ['-czf', tarball, '-C', source, '.'])
    report.artifacts.push({ target: label, file: tarball, sha256: sha256(tarball), bytes: readFileSync(tarball).length })
  }
  save()

  if (options.mode === 'dry-run') {
    report.status = 'dry-run'
    report.remote = { note: 'dry-run 未连接服务器；确认无误后跑 --preflight 或 --apply' }
    save()
    console.log(`\n[计划] 目标 ${options.host || '(未指定，需 --server 或 .env 的 host)'} → ${options.remoteRoot}`)
    console.log('[计划] 上传 server/portal 产物到 /tmp staging，校验后备份切换并重启 PM2，失败自动回滚')
    console.log(`\n✅ dry-run 完成（未上传、未重启）。报告：${reportPath}`)
    process.exit(0)
  }

  // 远程阶段
  if (!options.host) throw new Error('缺少目标主机：设置 .env 的 host 或传 --server')
  const transport = resolveTransport(options)
  report.host = options.host
  report.transport = transport.kind === 'openssh' ? 'openssh(免密)' : 'putty(密码)'
  save()
  console.log(`\n传输通道：${report.transport}`)

  const remoteScript = join(output, 'remote.sh')
  writeFileSync(remoteScript, renderRemoteScript({
    mode: options.mode, stamp, portalBase: options.portalBase, remoteRoot: options.remoteRoot,
    pm2Name: options.pm2Name, keepOldAssets: options.keepOldAssets,
  }))
  // 只传两个 tarball：远程脚本走 plink -m / ssh bash -s 的**文件通道**，不需要上传
  remoteUpload(transport, options, [serverTarball, portalTarball], '/tmp/')
  report.steps.push({ label: '上传 staging', code: 0 })
  save()

  const execution = remoteExec(transport, options, remoteScript)
  const remoteOutput = `${execution.stdout ?? ''}${execution.stderr ?? ''}`
  writeFileSync(join(output, 'remote.log'), remoteOutput)
  const outcome = remoteOutput.match(/ATR_DEPLOY_RESULT=(\S+)/)?.[1] ?? 'unknown'
  report.remote.execution = { code: execution.status, outcome }
  report.remote.health = remoteOutput.match(/ATR_DEPLOY_HEALTH=(.+)/)?.[1]?.trim()
  report.remote.oldPid = remoteOutput.match(/ATR_DEPLOY_OLD_PID=(\S+)/)?.[1]
  report.remote.newPid = remoteOutput.match(/ATR_DEPLOY_NEW_PID=(\S+)/)?.[1]
  report.remote.backup = remoteOutput.match(/ATR_DEPLOY_BACKUP=(\S+)/)?.[1]
  save()
  console.log(remoteOutput.trim())

  if (options.mode === 'preflight') {
    if (outcome !== 'preflight-ok') throw new Error(`preflight 未通过（${outcome}）`)
    report.status = 'preflight-ok'
    save()
    console.log(`\n✅ preflight 通过：产物已上传到 ${options.host}:/tmp 并通过完整性校验，现网未改动。报告：${reportPath}`)
    process.exit(0)
  }

  if (outcome === 'rolled-back') { report.rollback = '已回滚到部署前产物'; report.status = 'rolled-back' }
  if (outcome !== 'ok') throw new Error(`部署未成功（${outcome}），服务器状态见 ${join(output, 'remote.log')}`)

  // 只有真正重启成功、并且公网侧资源 MIME 正确，才算部署完成
  const asset = await verifyPublic(options.host, options.portalBase)
  report.status = 'deployed'
  report.finishedAt = new Date().toISOString()
  save()
  console.log(`\n公网校验通过：${asset.asset} → ${asset.status} ${asset.contentType}`)
  console.log(`✅ 部署完成。备份留在 ${report.remote.backup}，报告：${reportPath}`)
} catch (error) {
  if (report.status === 'running') report.status = 'failed'
  report.error = error instanceof Error ? error.message : String(error)
  report.finishedAt = new Date().toISOString()
  save()
  console.error(`\n❌ ${report.error}\n   报告：${reportPath}`)
  process.exitCode = 1
}