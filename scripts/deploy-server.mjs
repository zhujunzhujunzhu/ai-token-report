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
 * ★ 覆盖三样东西，绝不碰其余：
 *   - packages/server/dist 与 packages/web-portal/dist（构建产物）；
 *   - `deploy/atr-server-start.sh`（PM2 启动包装，**仓库里那一份是真源**；
 *     安装前备份进 .deploy-backup-*，健康检查失败连它一起回滚）。
 *   绝不碰：
 *   - node_modules：产物 external 了 `mysql2/promise`，靠 packages/server/node_modules 解析；
 *   - /root/.atr/portal.env：凭证与监听配置（只读它的 ATR_PORT 做健检）。
 *
 * ★ `--runtime bun|node`（缺省 bun）决定线上进程 exec 哪一个二进制。
 *   改运行时不是「换个参数」那么轻 —— 产物里若还没有 Bun 长口令的 TLS 修复，
 *   切过去会直接 errno 1045，所以 {@link assertBundleSupportsRuntime} 在**上传之前**判死。
 *
 * ⚠️ 子路径部署必须带 DSH_PORTAL_BASE（本站为 `/ai-token/`）。
 *   忘了带会构建出绝对路径产物，页面**立即变白且服务端零报错** —— 所以本地构建后
 *   直接断言 index.html 里的资源前缀，把这条人工约定钉死在脚本里。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  START_SCRIPT_REPO_PATH, assertBundleSupportsRuntime, renderRemoteScript, renderStartScript, resolveRuntime,
} from './deploy-plan.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------- 参数解析：拼错参数不能退回成真实部署 ----------
const DEFAULTS = { portalBase: '/ai-token/', remoteRoot: '/data/ai-token-report', pm2Name: 'ai-token-server', runtime: 'bun' }

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
    runtime: process.env['ATR_DEPLOY_RUNTIME'] ?? DEFAULTS.runtime,
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
    else if (arg === '--runtime') {
      const value = argv[++i] ?? ''
      // ⚠️ `--runtime --apply` 这类漏值必须当场报错：把下一个参数当成运行时名，
      //   会让「模式」静默退回 dry-run，或者反过来 —— 两种都很难看出来。
      if (!value || value.startsWith('--')) throw new Error('--runtime 缺少值（bun | node）')
      options.runtime = value
    }
    else throw new Error(`未知参数：${arg}`)
  }
  if (!options.portalBase.endsWith('/')) throw new Error(`--portal-base 必须以 / 结尾：${options.portalBase}`)
  if (options.skipVerify && options.fullVerify) throw new Error('--skip-verify 与 --full-verify 不能同时使用')
  // 提前校验运行时名：拼错成 `--runtime bunn` 不能等到上传之后才炸。
  resolveRuntime(options.runtime)
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
  runtime: options.runtime,
  steps: [], local: {}, artifacts: [], remote: {}, rollback: '未触发',
}
const reportPath = join(output, 'report.json')
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')

/** 同时落盘与透传的子进程执行；构建与验证的输出要能在终端实时看到。 */
function runStep(label, command, args, extraEnv = {}, stepCwd = root) {
  const index = String(report.steps.length + 1).padStart(2, '0')
  const logPath = join(output, `${index}-${label}.log`)
  console.log(`\n[${index}] ${label}\n    $ ${command} ${args.join(' ')}`)
  const started = Date.now()
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      // ⚠️ `cwd` 是**可传**的（打包那一步必须用它，见那里的注释）：
      //   少数命令（GNU tar）会把「看起来像 `host:path` 的绝对路径」当成远程规范，
      //   只有改成「切目录 + 相对文件名」才在两个平台上都走本地分支。
      cwd: stepCwd, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
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

/** 与 {@link runStep} 相同，但**换一个工作目录**（打包 tarball 用）。 */
function runStepIn(label, command, args, cwd) {
  return runStep(label, command, args, {}, cwd)
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
 *
 * 🚨 指纹形式必须用 **MD5 冒号**（`ab:cd:…`），不能用 `SHA256:…`。
 *   实测本机 PuTTY 0.72：`-hostkey SHA256:…`（含 `ssh-ed25519 255 SHA256:…` 变体）一律
 *   `not a valid format for a manual host key specification`，pscp 在**上传阶段**就失败，
 *   连密码那步都走不到；同一把钥匙换成裸 MD5 冒号形式即正常连上。
 *   而 `ssh-keygen -lf` 输出的是 SHA256，所以这里显式 `-E md5` 再剥掉 `MD5:` 前缀。
 *   MD5 形式新旧 PuTTY 都接受（新版本只是把 MD5 视为弱指纹），故它对两端都安全。
 */
function knownHostFingerprint(host, sshKeygen) {
  const knownHosts = join(homedir(), '.ssh', 'known_hosts')
  if (!existsSync(knownHosts) || !sshKeygen) return ''
  const line = readFileSync(knownHosts, 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${host} `) || l.startsWith(`${host},`))
  if (!line) return ''
  const scratch = join(tmpdir(), `atr-known-host-${process.pid}`)
  writeFileSync(scratch, `${line}\n`)
  const md5 = spawnSync(sshKeygen, ['-l', '-E', 'md5', '-f', scratch], { encoding: 'utf8' })
  const md5Fingerprint = md5.stdout.match(/MD5:([0-9a-f]{2}(?::[0-9a-f]{2}){15})/i)?.[1]
  // 兜底：极老的 OpenSSH 没有 -E md5 时退回 SHA256（新版 PuTTY 认这种形式）
  const sha256 = md5Fingerprint ? null : spawnSync(sshKeygen, ['-lf', scratch], { encoding: 'utf8' })
  rmSync(scratch, { force: true })
  if (md5Fingerprint) return md5Fingerprint
  return sha256?.stdout.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0] ?? ''
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
// ★ 生成逻辑住在 `scripts/deploy-plan.mjs` 的 `renderRemoteScript()`。
//   理由与 `scripts/release-plan.ts` 相同：它是整个部署里**最危险**的一段
//   （覆盖现网产物、覆盖启动包装、失败回滚），抽成纯模块才能被
//   `packages/server/test/deploy-plan.test.ts` 结构性地钉住 ——
//   而本文件因为 import 即执行，没法被测试直接引用。

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

  // ★ 运行时与启动包装：产物配不配得上这个运行时，在**上传之前**就判死。
  //   顺序错了（先切 Bun、产物里还没有长口令 TLS 修复）会以 errno 1045 的形式
  //   出现在目标机的 MySQL 连接上，而不是在这里 —— 那是最难查的一类失败。
  const runtime = resolveRuntime(options.runtime)
  const startTemplate = readFileSync(join(root, START_SCRIPT_REPO_PATH), 'utf8')
  const startScriptBody = renderStartScript(startTemplate, options.runtime)
  assertBundleSupportsRuntime(readFileSync(join(serverDist, 'main.mjs'), 'utf8'), options.runtime)
  const startScriptFile = join(output, `atr-deploy-${stamp}-start.sh`)
  writeFileSync(startScriptFile, startScriptBody)
  report.runtime = { name: runtime.name, label: runtime.label, bin: runtime.bin }
  console.log(`\n产物自检通过：main.mjs ${(report.local.serverDist.files / 1024).toFixed(0)} KB，index.html 带前缀 ${options.portalBase}`)
  console.log(`运行时：${runtime.label}（${{ bun: 'Bun 长口令 TLS 修复已确认在产物里', node: '无额外前置要求' }[runtime.name]}）→ ${runtime.bin}`)

  // 打包：一次一个 tar，传的与解的就是同一份字节
  // ★ 文件名自带 stamp：pscp 不能重命名，本地就按远端期望的名字产出，省掉一次远程 mv
  //
  // 🚨 **Windows 上必须给 tar 换工作目录 + 相对路径，不能给绝对路径**（2026-10-04 踩到）：
  //   GNU tar 的 `-f` 参数走的是「`host:path` = 从远端主机读文件」的老约定，
  //   于是 `D:\Coding_agent\...\x.tgz` 被它解析成「主机 `D`、路径 `\Coding_agent\...`」，
  //   报 `Cannot connect to D: resolve failed` + `Broken pipe`。
  //   POSIX 路径（`/data/...`）不含冒号所以没事 —— **这个 bug 只在 Windows 上出现**，
  //   而症状（连不上主机）与人名无关、读起来像网络问题，会把人带偏。
  //   修法：`cwd` 切到产物目录、只传**相对文件名**。相对路径不含冒号，
  //   两个平台都落在同一条「本地文件」分支上。
  const serverTarball = join(output, `atr-deploy-${stamp}-server.tgz`)
  const portalTarball = join(output, `atr-deploy-${stamp}-portal.tgz`)
  for (const [label, source, tarball] of [['server', serverDist, serverTarball], ['portal', portalDist, portalTarball]]) {
    const relative = basename(tarball)
    // ⚠️ 先确认产物目录真的存在：`-C` 指向不存在的目录时 tar 会在**别的**阶段失败，
    //   报错与真正的原因（目录拼错）无关。
    if (!existsSync(dirname(tarball))) throw new Error(`产物目录不存在：${dirname(tarball)}`)
    await runStepIn(`打包 ${label} 产物`, 'tar', ['-czf', relative, '-C', source, '.'], dirname(tarball))
    report.artifacts.push({ target: label, file: tarball, sha256: sha256(tarball), bytes: readFileSync(tarball).length })
  }
  save()

  if (options.mode === 'dry-run') {
    report.status = 'dry-run'
    report.remote = { note: 'dry-run 未连接服务器；确认无误后跑 --preflight 或 --apply' }
    save()
    console.log(`\n[计划] 目标 ${options.host || '(未指定，需 --server 或 .env 的 host)'} → ${options.remoteRoot}`)
    console.log(`[计划] 运行时 ${runtime.label}（${runtime.bin}）`)
    console.log('[计划] 上传 server/portal 产物 + 启动包装到 /tmp staging，校验后备份切换并重启 PM2，失败自动回滚')
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
    runtimeName: runtime.name, runtimeBin: runtime.bin,
    // ★ 远端路径必须与本地文件名逐字相同：pscp 不能重命名（见上面 tarball 那条注释）
    startScriptUpload: `/tmp/atr-deploy-${stamp}-start.sh`,
  }))
  // 只传这两份 tarball + 启动包装：远程脚本走 plink -m / ssh bash -s 的**文件通道**，不需要上传
  remoteUpload(transport, options, [serverTarball, portalTarball, startScriptFile], '/tmp/')
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
  // ★ 实际运行时是**探测出来的事实**，不是我们传进去的期望值 —— 两个都记进报告，
  //   否则「部署成功、但进程跑的是另一个二进制」在报告里完全看不出来。
  const runtimeExpected = remoteOutput.match(/ATR_DEPLOY_RUNTIME_EXPECTED=(\S*)/)?.[1]
  const runtimeActual = remoteOutput.match(/ATR_DEPLOY_RUNTIME_ACTUAL=(\S*)/)?.[1]
  if (runtimeExpected || runtimeActual) {
    report.remote.runtime = { expected: runtimeExpected ?? '', actual: runtimeActual ?? '' }
  }
  save()
  console.log(remoteOutput.trim())

  if (options.mode === 'preflight') {
    if (outcome !== 'preflight-ok') throw new Error(`preflight 未通过（${outcome}）`)
    report.status = 'preflight-ok'
    save()
    console.log(`\n✅ preflight 通过：产物与启动包装已上传到 ${options.host}:/tmp 并通过完整性校验，现网未改动。报告：${reportPath}`)
    process.exit(0)
  }

  // 运行时对不上是一种**独立**的失败：服务是活的，但进程跑错了二进制。
  // 远端已经回滚并回报了原因，不能把它并进下面那条「部署未成功」的泛化信息里 ——
  // 两者的排查方向完全不同。
  if (outcome === 'runtime-mismatch') {
    report.rollback = '已回滚（运行时断言未通过）'
    report.status = 'runtime-mismatch'
    save()
    throw new Error(
      `服务健康但进程跑的不是 ${runtime.bin}（实际 ${runtimeActual || '未知'}）；远端已回滚。`
      + `多半是启动包装没装上、或 pm2 复用了旧进程 —— 见 ${join(output, 'remote.log')}`,
    )
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