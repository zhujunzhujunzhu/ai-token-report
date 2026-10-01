/**
 * 本地 → 目标服务器的**通用远程执行 / 传输**小工具（运行时 A/B 的驱动）。
 *
 * 用法（在仓库根，用 node 跑）：
 *   node packages/server/verify/perf/runtime-ab/ssh-exec.mjs <本地脚本> [位置参数...]
 *   node packages/server/verify/perf/runtime-ab/ssh-exec.mjs --out <本地文件> <远程路径>
 *   node packages/server/verify/perf/runtime-ab/ssh-exec.mjs --get <远程路径> <本地文件>
 *
 * 与 `verify/perf/online-probe.ts` 的分工：那个只负责「在服务器上跑一段只读 SQL」；
 * 这个要跑**任意 shell** 并双向传文件，`run.sh` / `fixture.sh` 都靠它送上去。
 *
 * 凭证取自仓库根 `.env` 的 `host` / `password`（与 `scripts/deploy-server.mjs` 同一份）。
 * 口令只走 `-pwfile`，绝不进命令行、绝不打印。
 *
 * ## 四条实测踩出来的规矩
 *
 * 1. 🚨 **`pscp` 在 PuTTY 0.72 上不认 `-pwfile`**（只有 plink 认），于是传文件也不能走
 *    pscp（剩下的 `-pw <口令>` 会把口令写进进程命令行）。改成「base64 分片 + heredoc 追加」。
 *    实测整份 1.3 MB 的 base64 一次塞进单个 heredoc 会让连接
 *    `Network error: Software caused connection abort`，**必须分片**。
 * 2. ⚠️ **主机指纹只认裸 MD5 冒号形式**（`ab:cd:…`），`ssh-keygen -l` 默认吐的
 *    `SHA256:…` 会被 PuTTY 0.72 拒绝（详见 `docs/服务器部署.md`）。
 * 3. 🚨 **远端脚本里不要用 `pkill -f <模式>`**：plink 会把整段脚本文本放进远端进程的
 *    命令行里，模式会匹配到自己那个 shell 并把它杀掉 —— 表现为「输出戛然而止 +
 *    退出码 1」，看起来像网络问题。要杀进程请按 PID 杀（见 `fixture.sh`）。
 * 4. ⚠️ 位置参数是通过在脚本文本开头插一行 `set -- …` 注入的：远端跑的是 `bash -s`，
 *    没有 argv。只在脚本自己读 `"$@"` 时有意义（`run.sh` 符合）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const dotenv = {}
for (const raw of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const line = raw.trim()
  if (!line || line.startsWith('#')) continue
  const eq = line.indexOf('=')
  if (eq > 0) dotenv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
}
export const host = process.env['ATR_DEPLOY_HOST'] ?? dotenv['host'] ?? ''
export const password = process.env['ATR_DEPLOY_PASSWORD'] ?? dotenv['password'] ?? ''
export const user = process.env['ATR_DEPLOY_USER'] ?? 'root'
if (!host || !password) throw new Error('.env 缺少 host / password')

function which(name) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true })
  const first = result.stdout?.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0]
  return result.status === 0 && first ? first : undefined
}
export function hostkey() {
  const knownHosts = join(homedir(), '.ssh', 'known_hosts')
  const line = readFileSync(knownHosts, 'utf8').split(/\r?\n/)
    .find((entry) => entry.startsWith(`${host} `) || entry.startsWith(`${host},`))
  if (!line) throw new Error(`known_hosts 里没有 ${host}`)
  const scratch = join(tmpdir(), `atr-known-${process.pid}`)
  writeFileSync(scratch, `${line}\n`)
  try {
    const result = spawnSync(which('ssh-keygen'), ['-l', '-E', 'md5', '-f', scratch], { encoding: 'utf8', windowsHide: true })
    const match = /MD5:([0-9a-f:]+)/i.exec(result.stdout ?? '')
    if (!match) throw new Error(`无法计算主机指纹：${result.stdout}${result.stderr}`)
    return match[1]
  } finally { rmSync(scratch, { force: true }) }
}

const target = `${user}@${host}`

/** 免密 ssh 是否可用（每次进程只探测一次）。 */
let sshMode = null
function detectSsh() {
  if (sshMode !== null) return sshMode
  const ssh = which('ssh')
  if (!ssh) { sshMode = false; return false }
  const probe = spawnSync(ssh, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', target, 'true'], { encoding: 'utf8', windowsHide: true })
  sshMode = probe.status === 0
  return sshMode
}

/** 在服务器上跑一段 bash，返回 { status, stdout, stderr }。 */
export function runRemote(script) {
  const scratch = mkdtempSync(join(tmpdir(), 'atr-remote-'))
  const scriptPath = join(scratch, 'remote.sh')
  writeFileSync(scriptPath, script.replace(/\r\n/g, '\n'))
  try {
    if (detectSsh()) {
      return spawnSync(which('ssh'), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', target, 'bash -s'], {
        input: script, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024,
      })
    }
    const plink = which('plink')
    if (!plink) throw new Error('既没有免密 ssh，也没找到 plink')
    const pwFile = join(scratch, 'pw.txt')
    writeFileSync(pwFile, password)
    const hk = hostkey()
    const attempt = (authArgs) => spawnSync(plink, ['-ssh', '-batch', '-hostkey', hk, ...authArgs, '-m', scriptPath, target], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024,
    })
    let result = attempt(['-pwfile', pwFile])
    if (result.status !== 0 && /unknown option|invalid option/i.test(result.stderr ?? '')) result = attempt(['-pw', password])
    return result
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

/**
 * 上传本地文件：走 SSH stdin 的 base64 heredoc。
 *
 * ⚠️ 刻意**不用 pscp**：PuTTY 0.72 的 pscp **不认 `-pwfile`**（plink 才认），
 *   只剩 `-pw <口令>` 一条路，那会把 root 口令写进进程命令行。
 *   plink 从 stdin 收脚本这条通道已经在用，base64 复用它最省事也最安全。
 */
export function put(localPath, remotePath) {
  const buffer = readFileSync(localPath)
  const payload = buffer.toString('base64')
  // ⚠️ **必须分片**：把整份 base64 塞进一个 heredoc 会让某次传输以
  //   `Network error: Software caused connection abort` 结束（实测 1.3MB 单块必失败）。
  //   每片独立一次连接、以 `>>` 追加，任何一片失败都能立刻定位。
  const CHUNK = 64 * 1024
  const chunks = []
  for (let i = 0; i < payload.length; i += CHUNK) chunks.push(payload.slice(i, i + CHUNK))
  runRemote(`set -eu\nmkdir -p "$(dirname '${remotePath}')"\n: > '${remotePath}'\n`)
  chunks.forEach((chunk, index) => {
    const result = runRemote(`set -eu
cat <<'ATR_PUT_EOF' >> '${remotePath}.b64'
${chunk}
ATR_PUT_EOF
`)
    if (result.status !== 0) throw new Error(`上传第 ${index + 1}/${chunks.length} 片失败：${result.stderr || result.stdout}`)
  })
  const finish = runRemote(`set -eu
base64 -d '${remotePath}.b64' > '${remotePath}'
rm -f '${remotePath}.b64'
chmod 0644 '${remotePath}'
wc -c < '${remotePath}'
`)
  if (finish.status !== 0) throw new Error(`上传收尾失败：${finish.stderr || finish.stdout}`)
  const size = Number((finish.stdout ?? '').trim().split(/\r?\n/).pop())
  if (size !== buffer.length) throw new Error(`上传字节数不符：远程 ${size} / 本地 ${buffer.length}`)
}

/** 把远程文件取回本地（base64 over stdout）。 */
export function get(remotePath, localPath) {
  const script = `set -eu
base64 -w0 '${remotePath}'
echo
`
  const result = runRemote(script)
  if (result.status !== 0) throw new Error(`取回失败：${result.stderr || result.stdout}`)
  const b64 = (result.stdout ?? '').trim()
  const buffer = Buffer.from(b64, 'base64')
  writeFileSync(localPath, buffer)
}

// ── CLI ────────────────────────────────────────────────────────────────────
if (import.meta.main || process.argv[1]?.endsWith('ssh-exec.mjs')) {
  const args = process.argv.slice(2)
  if (args[0] === '--out' || args[0] === '--put') {
    const [, localPath, remotePath] = args
    if (!localPath || !remotePath || !existsSync(localPath)) throw new Error('用法：--out <本地文件> <远程路径>')
    runRemote(`mkdir -p "$(dirname '${remotePath}')"`)
    put(localPath, remotePath)
    console.log(`PUT ${localPath} -> ${remotePath}`)
  } else if (args[0] === '--get') {
    const [, remotePath, localPath] = args
    get(remotePath, localPath)
    console.log(`GET ${remotePath} -> ${localPath}`)
  } else {
    if (!args[0] || !existsSync(args[0])) throw new Error('用法：ssh-exec.mjs <本地脚本> [位置参数...]')
    // 位置参数：远端跑的是 `bash -s`，没有 argv，所以在脚本文本开头插一行 `set --`。
    const extra = args.slice(1).map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
    const body = readFileSync(args[0], 'utf8')
    const result = runRemote(extra ? `set -- ${extra}\n${body}` : body)
    process.stdout.write(result.stdout ?? '')
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.status !== 0) process.exitCode = result.status ?? 1
  }
}
