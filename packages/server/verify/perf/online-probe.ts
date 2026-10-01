/**
 * 线上库只读探查：**在服务器上用 MySQL 客户端跑一段 SQL**，只看结果。
 *
 * ```bash
 * bun run packages/server/verify/perf/online-probe.ts --sql "SELECT VERSION()"
 * bun run packages/server/verify/perf/online-probe.ts --file some.sql
 * ```
 *
 * ## 为什么走 SSH 而不是直连 3308
 *
 * 线上 MySQL 只监听服务器本地（`127.0.0.1:3308`），公网连不上；SSH 是既有的、
 * 部署脚本已经在用的通道。凭证取自**仓库 `.env` 的 `host` / `password`**
 * （与 `scripts/deploy-server.mjs` 同一份，生产 root）。
 *
 * ## 安全约束（照抄部署脚本的规矩）
 *
 * 1. **口令绝不进命令行**：走 `plink -pw` 也会出现在进程表里，所以这里优先用
 *    `-pwfile`（PuTTY 支持），失败再退回 `-pw`；无论如何**不打印**。
 * 2. **只做只读 SQL**：脚本自己拒绝非 `SELECT` / `SHOW` / `EXPLAIN` / `WITH` 开头的语句。
 * 3. 数据库口令在**服务器上**从 `/root/.atr/mysql8-credentials.txt` 读，
 *    本地拿不到也不需要它。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** 读仓库根 `.env` 的 `KEY=VALUE`（**只取需要的两个键**，其余一概不碰）。 */
function readDotEnv(): Record<string, string> {
  const path = join(process.cwd(), '.env')
  if (!existsSync(path)) throw new Error('找不到仓库根 .env')
  const out: Record<string, string> = {}
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

const dotenv = readDotEnv()
const host = process.env['ATR_DEPLOY_HOST'] ?? dotenv['host'] ?? ''
const password = process.env['ATR_DEPLOY_PASSWORD'] ?? dotenv['password'] ?? ''
const user = process.env['ATR_DEPLOY_USER'] ?? 'root'
const remoteRoot = process.env['ATR_DEPLOY_ROOT'] ?? '/data/ai-token-report'
if (!host || !password) throw new Error('.env 缺少 host / password')

function which(name: string): string | undefined {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true })
  const first = result.stdout?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0]
  return result.status === 0 && first ? first : undefined
}
/** 从 known_hosts 取主机指纹（MD5，PuTTY 0.72 只认这个格式）。 */
function knownHostFingerprint(target: string): string {
  const knownHosts = join(homedir(), '.ssh', 'known_hosts')
  if (!existsSync(knownHosts)) throw new Error('没有 ~/.ssh/known_hosts')
  const line = readFileSync(knownHosts, 'utf8').split(/\r?\n/)
    .find((entry) => entry.startsWith(`${target} `) || entry.startsWith(`${target},`))
  if (!line) throw new Error(`known_hosts 里没有 ${target}`)
  const sshKeygen = which('ssh-keygen')
  if (!sshKeygen) throw new Error('找不到 ssh-keygen')
  const scratch = join(tmpdir(), `atr-known-${process.pid}`)
  writeFileSync(scratch, `${line}\n`)
  try {
    const result = spawnSync(sshKeygen, ['-l', '-E', 'md5', '-f', scratch], { encoding: 'utf8', windowsHide: true })
    const match = /MD5:([0-9a-f:]+)/i.exec(result.stdout ?? '')
    if (!match) throw new Error(`无法计算主机指纹：${result.stdout}${result.stderr}`)
    return match[1]!
  } finally { rmSync(scratch, { force: true }) }
}

/**
 * 在服务器上执行的 shell 脚本。
 *
 * ⚠️ 数据库口令从**服务器上的凭证文件**读，且用 `--defaults-extra-file` 传给
 *   mysql 客户端 —— 命令行里不出现口令（`ps` 看不到）。
 */
function remoteScript(sql: string): string {
  return `set -e
CRED=/root/.atr/mysql8-credentials.txt
[ -r "$CRED" ] || { echo "ONLINE_PROBE_ERROR: 读不到 $CRED" >&2; exit 3; }
APW=$(grep -A5 '^\\[atr_user\\]' "$CRED" | grep '^password=' | cut -d= -f2-)
[ -n "$APW" ] || { echo "ONLINE_PROBE_ERROR: 凭证文件里没有 atr_user 的 password" >&2; exit 3; }
CNF=$(mktemp)
trap 'rm -f "$CNF"' EXIT
chmod 600 "$CNF"
printf '[client]\\nuser=atr_user\\npassword=%s\\nhost=127.0.0.1\\nport=3308\\n' "$APW" > "$CNF"
/usr/local/mysql8/bin/mysql --defaults-extra-file="$CNF" -N --batch ai_token_report <<'ATR_SQL_EOF'
${sql}
ATR_SQL_EOF
`
}

function run(sql: string): string {
  const script = remoteScript(sql)
  const target = `${user}@${host}`
  const scratch = mkdtempSync(join(tmpdir(), 'atr-online-probe-'))
  const scriptPath = join(scratch, 'remote.sh')
  writeFileSync(scriptPath, script.replace(/\r\n/g, '\n'))
  try {
    // ① 先试 OpenSSH 免密（本机已知无密钥，但保留以免环境变化）
    const ssh = which('ssh')
    if (ssh) {
      const probe = spawnSync(ssh, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', target, 'true'], { encoding: 'utf8', windowsHide: true })
      if (probe.status === 0) {
        const result = spawnSync(ssh, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', target, 'bash -s'], {
          input: script, encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024 * 1024,
        })
        if (result.status !== 0) throw new Error(`远程 SQL 失败（ssh）：${result.stderr || result.stdout}`)
        return result.stdout ?? ''
      }
    }
    // ② PuTTY：口令走 -pwfile（不进命令行），失败再退回 -pw
    const plink = which('plink')
    if (!plink) throw new Error('既没有免密 ssh，也没找到 plink')
    const hostkey = knownHostFingerprint(host)
    const pwFile = join(scratch, 'pw.txt')
    writeFileSync(pwFile, password)
    const attempt = (authArgs: string[]): { status: number | null; stdout: string; stderr: string } =>
      spawnSync(plink, ['-ssh', '-batch', '-hostkey', hostkey, ...authArgs, '-m', scriptPath, target], {
        encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024 * 1024,
      })
    let result = attempt(['-pwfile', pwFile])
    if (result.status !== 0 && /unknown option|invalid option/i.test(result.stderr ?? '')) {
      result = attempt(['-pw', password])
    }
    if (result.status !== 0) throw new Error(`远程 SQL 失败（plink）：${result.stderr || result.stdout}`)
    return result.stdout ?? ''
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// ── 入参 ────────────────────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/**
 * `--bench`：把 `--file` 里的每条语句**逐条串行执行并用服务端时钟计时**。
 *
 * ★ 为什么用服务端时钟：SSH 往返（本机 → 117.72.173.21）会把客户端计时
 *   污染成「网络延迟 + 查询时间」。`NOW(6)` 前后差分只量数据库自己花了多久。
 *   两者都打印，差额就是通道开销（用来判断「慢」到底是库还是链路）。
 */
function benchStatements(sql: string): string {
  const statements = sql.split(';').map((part) => part.replace(/--.*$/gm, '').trim()).filter(Boolean)
  const lines: string[] = []
  for (const statement of statements) {
    const oneLine = statement.replace(/\s+/g, ' ').trim()
    const label = /^SELECT '([A-Za-z_]+)'/.exec(oneLine)?.[1] ?? 'probe'
    // ⚠️ 顺序必须是「记时刻 → 执行 → 再记时刻」。
    //   把 `SET @t0` 写在执行之后，量到的就只是「取时刻本身」的耗时（0.0x ms），
    //   会把报告变成一份「所有查询都很快」的假数据。
    lines.push(`SET @t0 = NOW(6);`)
    lines.push(`${oneLine};`)
    lines.push(`SELECT '${label}' AS probe, ROUND(TIMESTAMPDIFF(MICROSECOND, @t0, NOW(6))/1000, 2) AS server_ms;`)
  }
  return lines.join('\n')
}

let sql = arg('sql') ?? ''
const file = arg('file')
if (file) sql = readFileSync(file, 'utf8')
// 注释先剥掉再校验：否则一条 `-- 说明` 开头的语句会被只读闸门拒掉（它确实不是 SELECT）。
sql = sql.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('--')).join('\n')
if (!sql.trim()) throw new Error('需要 --sql "..." 或 --file <path>')
if (process.argv.includes('--bench')) sql = benchStatements(sql)

/**
 * 🚨 只读闸门：只允许查询类语句。
 *
 * 这不是洁癖 —— 线上库是这个项目的**唯一副本**，一次手滑的 UPDATE/DROP
 * 没有任何东西可以还原。要写数据请走正式迁移脚本。
 *
 * ⚠️ `SET @x = ...`（会话变量）是唯一放行的写形状 —— 它不碰任何表，
 *   只用于 `--bench` 的服务端计时。但 `SET GLOBAL` / `SET PERSIST` /
 *   `SET @@global.*` 会改**服务器状态**，一律拒绝。
 */
const statements = sql.split(';').map((part) => part.trim()).filter(Boolean)
for (const statement of statements) {
  const readOnly = /^(SELECT|SHOW|EXPLAIN|DESC|DESCRIBE|WITH|USE)\b/i.test(statement)
  const sessionVar = /^SET\s+@[A-Za-z_][A-Za-z0-9_]*\s*=/.test(statement) && !/@@|GLOBAL|PERSIST/i.test(statement)
  if (!readOnly && !sessionVar) {
    throw new Error(`拒绝执行非只读语句：${statement.slice(0, 60)}`)
  }
}
void remoteRoot

console.log(run(sql))
