/**
 * 到线上部门库（MySQL 8.0 @ 117.72.173.21:3308）的**本地 SSH 隧道**。
 *
 * ```bash
 * bun scripts/mysql-tunnel.mjs start              # 前台常驻：本地 13308 → 线上 127.0.0.1:3308
 * bun scripts/mysql-tunnel.mjs start --port 13399 # 换个本地端口
 * bun scripts/mysql-tunnel.mjs check              # 自检：监听 + 真 MySQL 握手
 * bun scripts/mysql-tunnel.mjs print              # 只打印 Navicat 该填什么（含从 .env 取的口令）
 * ```
 *
 * ## 为什么是隧道而不是开公网口
 *
 * 线上 8.0 实例 `bind-address=127.0.0.1`，公网连不上；改它要重启 MySQL、建远程账号、
 * 开京东云安全组，且 `caching_sha2_password` 在非 TLS 下口令会过公网。走 SSH 隧道
 * **服务器端零改动**，MySQL 流量在服务器本机回环里落地，链路整体被 SSH 加密。
 *
 * ## 安全约束（照抄 `packages/server/verify/perf/online-probe.ts` 的规矩）
 *
 * 1. **口令绝不进命令行**：优先 `plink -pwfile`（PuTTY 支持）。`-pw` 会出现在进程表里，
 *    只在 `-pwfile` 不被支持时才退回，且无论如何**不打印**。
 * 2. **主机指纹不写死**：从本机 `~/.ssh/known_hosts` 现算 MD5 指纹交给 plink 钉住。
 * 3. **只读 `.env` 里需要的两个键**（`host` / `password`），其余一概不碰。
 * 4. 自检只做 TCP 连接 + 读一个 MySQL 握手包，**不发送任何 SQL**，更不写库。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 本地监听端口。刻意避开 3306 / 3308，免得和本机既有 MySQL 抢端口。 */
const DEFAULT_LOCAL_PORT = 13308
/** 线上 MySQL 8.0 只监听服务器回环（`/etc/my8.cnf` 的 `bind-address=127.0.0.1`）。 */
const REMOTE_MYSQL = { host: '127.0.0.1', port: 3308, schema: 'ai_token_report' }

// ---------------------------------------------------------------------------
// 参数与 .env
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const command = argv.find((a) => !a.startsWith('-')) ?? 'start'

/** `--port N` / `--port=N`。 */
function flagNumber(name, fallback) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) {
    const value = Number(eq.slice(name.length + 3))
    if (!Number.isInteger(value) || value <= 0 || value > 65535) throw new Error(`--${name} 不是合法端口：${eq}`)
    return value
  }
  const index = argv.indexOf(`--${name}`)
  if (index >= 0) {
    const value = Number(argv[index + 1])
    if (!Number.isInteger(value) || value <= 0 || value > 65535) throw new Error(`--${name} 不是合法端口：${argv[index + 1]}`)
    return value
  }
  return fallback
}

/** 读仓库根 `.env` 的 `KEY=VALUE`（**只取需要的键**，其余一概不碰）。 */
function readDotEnv() {
  const path = join(process.cwd(), '.env')
  if (!existsSync(path)) throw new Error('找不到仓库根 .env（需要有 host / password 两个键）')
  const out = {}
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

const localPort = flagNumber('port', DEFAULT_LOCAL_PORT)
const dotenv = readDotEnv()
const sshHost = process.env['ATR_DEPLOY_HOST'] ?? dotenv['host'] ?? ''
const sshPassword = process.env['ATR_DEPLOY_PASSWORD'] ?? dotenv['password'] ?? ''
const sshUser = process.env['ATR_DEPLOY_USER'] ?? 'root'
if (!sshHost || !sshPassword) throw new Error('.env 缺少 host / password')

/** 库里两个账号（口令与 `docs/账号密码清单-20260928.md` §4 一致）。 */
const DB_USERS = {
  'atr_user': '8IM__w.8cyaGsqVcMssUO.GYvuQOMTUj',
  'root': 'HiqtEm_.1hIr9-O27NNdUOf-qvZ70mpB',
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function which(name) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true })
  const first = (result.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0]
  return result.status === 0 && first ? first : undefined
}

/** 从 known_hosts 取主机指纹（MD5，PuTTY 0.72+ 只认这个格式）。 */
function knownHostFingerprint(target) {
  const knownHosts = join(homedir(), '.ssh', 'known_hosts')
  if (!existsSync(knownHosts)) return undefined
  const line = readFileSync(knownHosts, 'utf8').split(/\r?\n/)
    .find((entry) => entry.startsWith(`${target} `) || entry.startsWith(`${target},`))
  if (!line) return undefined
  const sshKeygen = which('ssh-keygen')
  if (!sshKeygen) return undefined
  const scratch = join(tmpdir(), `atr-known-${process.pid}`)
  writeFileSync(scratch, `${line}\n`)
  try {
    const result = spawnSync(sshKeygen, ['-l', '-E', 'md5', '-f', scratch], { encoding: 'utf8', windowsHide: true })
    const match = /MD5:([0-9a-f:]+)/i.exec(result.stdout ?? '')
    return match ? match[1] : undefined
  } finally {
    rmSync(scratch, { force: true })
  }
}

/** 口令落一个 600 的临时文件，交给 `plink -pwfile`；调用方负责删。 */
function writePasswordFile(password) {
  const dir = mkdtempSync(join(tmpdir(), 'atr-tunnel-'))
  const file = join(dir, 'pw')
  writeFileSync(file, password, { encoding: 'utf8', mode: 0o600 })
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** TCP 连接 + 读 MySQL 初始握手包：不用装客户端也能证明「对面真是 MySQL」。 */
function probeMySql(port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (verdict) => {
      socket.destroy()
      resolve(verdict)
    }
    socket.setTimeout(timeoutMs, () => done({ ok: false, reason: `TCP 超时（${timeoutMs}ms）` }))
    socket.on('error', (error) => done({ ok: false, reason: `TCP 失败：${error.code ?? error.message}` }))
    socket.once('data', (buf) => {
      // 握手包：3 字节长度 + 1 字节序号 + 1 字节协议版本(0x0a) + 版本字符串 NUL 结尾
      if (buf.length > 5 && buf[4] === 0x0a) {
        const end = buf.indexOf(0, 5)
        done({ ok: true, serverVersion: buf.subarray(5, end > 0 ? end : buf.length).toString('utf8') })
      } else {
        done({ ok: false, reason: `收到的不是 MySQL 握手包（前 5 字节：${buf.subarray(0, 5).toString('hex')}）` })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

function printNavicat() {
  const lines = [
    '',
    'Navicat 新建 MySQL 连接（**不要**勾 SSH 隧道，因为隧道已经在本机了）：',
    '',
    `  连接名    ai-token-report(隧道)`,
    `  主机      127.0.0.1`,
    `  端口      ${localPort}`,
    `  用户名    atr_user`,
    `  密码      ${DB_USERS['atr_user']}`,
    `  数据库    ${REMOTE_MYSQL.schema}`,
    '',
    '  要动表结构就换成 root / ' + DB_USERS['root'] + '（root 权限齐全）',
    '',
    `  原始连接串：mysql://atr_user:${DB_USERS['atr_user']}@127.0.0.1:${localPort}/${REMOTE_MYSQL.schema}`,
    '',
    '⚠️ 这些口令是明文，别贴进聊天记录/工单。',
    '',
  ]
  console.log(lines.join('\n'))
}

async function check() {
  const verdict = await probeMySql(localPort)
  if (!verdict.ok) {
    console.log(`❌ 本地 ${localPort} 上没有可用隧道：${verdict.reason}`)
    console.log('   先跑：bun scripts/mysql-tunnel.mjs start')
    process.exitCode = 1
    return
  }
  console.log(`✅ 隧道可用：127.0.0.1:${localPort} → ${sshHost} → ${REMOTE_MYSQL.host}:${REMOTE_MYSQL.port}`)
  console.log(`   对面握手报的版本：${verdict.serverVersion}`)
}

function start() {
  const fingerprint = knownHostFingerprint(sshHost)
  if (!fingerprint) throw new Error(`~/.ssh/known_hosts 里没有 ${sshHost}，先用 ssh 连一次登记主机指纹`)
  const plink = which('plink') ?? 'C:\\Program Files\\PuTTY\\plink.exe'
  if (!existsSync(plink)) throw new Error('找不到 plink（PuTTY），请安装或改用 OpenSSH')
  const { file, cleanup } = writePasswordFile(sshPassword)
  // OpenSSH 作为退路：`ssh -N -L …`。它没有 -pwfile，只能靠免密或交互输入。
  const usePlink = true
  const args = [
    '-batch',
    '-hostkey', fingerprint,
    ...(usePlink ? ['-pwfile', file] : []),
    '-N', // 不执行远端命令，只做转发
    '-L', `${localPort}:${REMOTE_MYSQL.host}:${REMOTE_MYSQL.port}`,
    `${sshUser}@${sshHost}`,
  ]
  console.log(`建立隧道：127.0.0.1:${localPort} → ${sshHost} → ${REMOTE_MYSQL.host}:${REMOTE_MYSQL.port}`)
  console.log('（保持本窗口开着；Ctrl+C 断开。断线后重跑本命令即可）\n')
  const child = spawn(plink, args, { stdio: 'inherit', windowsHide: true })
  const finish = () => {
    cleanup()
    rmSync(file, { force: true })
  }
  child.on('exit', (code) => {
    finish()
    console.log(`\n隧道已断开（plink 退出码 ${code}）`)
  })
  process.on('SIGINT', () => {
    child.kill()
    finish()
    process.exit(0)
  })
}

/** 关掉占用本地端口的 plink 进程（隧道可能是本脚本起的，也可能是手工起的）。 */
function stop() {
  if (process.platform !== 'win32') {
    console.log('非 Windows：请用 `pkill -f "L ${localPort}:"` 结束隧道')
    return
  }
  const found = spawnSync('powershell', [
    '-NoProfile', '-Command',
    `Get-NetTCPConnection -LocalPort ${localPort} -State Listen -ErrorAction SilentlyContinue | ` +
      'Select-Object -ExpandProperty OwningProcess -Unique | ' +
      'ForEach-Object { $p = Get-Process -Id $_ -ErrorAction SilentlyContinue; if ($p) { "$($p.Id) $($p.ProcessName)" } }',
  ], { encoding: 'utf8', windowsHide: true })
  const rows = (found.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (rows.length === 0) {
    console.log(`本地 ${localPort} 上没有监听进程，隧道已不在`)
    return
  }
  for (const row of rows) {
    const pid = row.split(/\s+/)[0]
    const killed = spawnSync('taskkill', ['/PID', pid, '/F'], { encoding: 'utf8', windowsHide: true })
    console.log(`已结束 ${row} → ${(killed.stdout ?? '').trim() || (killed.stderr ?? '').trim()}`)
  }
}

if (command === 'start') start()
else if (command === 'check') await check()
else if (command === 'print') printNavicat()
else if (command === 'stop') stop()
else if (command === 'probe') console.log(JSON.stringify(await probeMySql(localPort)))
else {
  console.log('用法：bun scripts/mysql-tunnel.mjs <start|check|print|stop|probe> [--port 13308]')
  process.exitCode = 1
}
