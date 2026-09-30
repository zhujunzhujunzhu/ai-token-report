/**
 * 本地启动的自助配置（`bun run server` 用）。
 *
 * ## 为什么需要它
 *
 * 后台登录的验证码答案以 `HMAC(ATR_CAPTCHA_HMAC_KEY, challenge_id:answer)` 落库，
 * 密钥缺失时验证码与登录**一律**返回 503（见 `identity/portal-auth.ts`）。
 * 而空库里连管理员账号也没有 —— 于是「本机起个服务端看看页面」要手配两个环境变量，
 * 并且**每开一个新 shell 都要重配一遍**：服务端只读 `process.env`，不读 `.env`。
 *
 * 这里把那份配置落成数据目录下的 `server.env`（**不在仓库内**，不可能被误提交），
 * 启动时先读它、缺什么补什么，于是「本机自用」只差一条 `bun run server`。
 *
 * ## 只管「本机自己玩」这一种情形
 *
 * 只有**本机 SQLite 上报库 + 回环监听**才自动生成：
 * - 配了 `--mysql` / `ATR_MYSQL_URL`（共享库，多半是生产）→ 不生成，只加载已有文件；
 * - `--host` 不是回环地址（要对全组开放）→ 不生成。
 *
 * 这两条不是洁癖：多实例共享一个上报库时，各实例的密钥必须**是同一个**，
 * 自动生成会让它们各不相同，而表现是「验证码永远错」这种查不出原因的故障
 * （`login()` 会比对 `hmac_key_id`）。所以那两种情形交给部署环境显式配置。
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 本地配置文件（落在**数据目录**下，与仓库分离）。 */
export const LOCAL_ENV_FILE = 'server.env'

/** 本地自动初始化的管理员用户名（密码随机生成，只有空库首次生效）。 */
export const LOCAL_ADMIN_USERNAME = 'admin'

/** 本模块托管（会读、会写）的三个键；文件里其它 `ATR_*` 只读不写。 */
const MANAGED_KEYS = ['ATR_CAPTCHA_HMAC_KEY', 'ATR_ADMIN_USERNAME', 'ATR_ADMIN_PASSWORD'] as const

/** 回环监听的写法（`main.ts` 的 `--host` 支持这几种）。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

const HEADER = [
  '# ai-token-report 本地配置：由 `bun run server` 自动读取 / 生成，不在仓库内。',
  '# 只在本机 SQLite 上报库 + 回环监听时自动生成；共享库 / 对外监听 / 多实例请显式配置环境变量。',
]

/**
 * 解析环境文件文本。
 *
 * 语义**故意**与服务器上的 `set -a; . /root/.atr/portal.env` 接近而**不是** shell：
 * 只认 `KEY=VALUE` 与 `#` 注释，不做变量展开、不执行任何东西 ——
 * 这个文件里的值是口令，不该由 shell 语法参与解释。
 */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    const quoted = value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    if (quoted) value = value.slice(1, -1)
    out[key] = value
  }
  return out
}

export interface PrepareLocalEnvOptions {
  /** 数据目录（`resolveDataDir()` 的结果或 `--data-dir`）。 */
  dataDir: string
  /** 命令行参数（`process.argv.slice(2)`）：只读 `--host` / `--mysql` / `--help`。 */
  argv: readonly string[]
  /** 待填充的环境；缺省 `process.env`（测试注入普通对象）。 */
  env?: Record<string, string | undefined>
}

export interface PrepareLocalEnvResult {
  /** 配置文件路径（无论是否存在）。 */
  path: string
  /** 本次从文件读进环境的键。 */
  loaded: string[]
  /** 本次新生成并写盘的键。 */
  created: string[]
  /** 走完这一步仍然缺失的托管键。 */
  missing: string[]
  /** 未自动生成的原因（配置齐全或已生成时为 undefined）。 */
  manualReason?: string
}

/**
 * 备好本地配置：先加载已有的 `server.env`，在允许的情形下补齐缺失项并写盘。
 *
 * ⚠️ 顺序是「文件 → 判断 → 生成」：先加载才能让文件里的 `ATR_MYSQL_URL` 参与
 *   「这是不是共享库」的判断（否则一个已经指向共享库的文件会被当成全新本机实例）。
 * ⚠️ **绝不覆盖**外部已经设好的值：显式传进来的环境变量永远优先于文件与生成值。
 */
export function prepareLocalEnv(options: PrepareLocalEnvOptions): PrepareLocalEnvResult {
  const env = options.env ?? process.env
  const path = join(options.dataDir, LOCAL_ENV_FILE)

  const loaded: string[] = []
  if (existsSync(path)) {
    for (const [key, value] of Object.entries(parseEnvText(readFileSync(path, 'utf8')))) {
      if (!key.startsWith('ATR_') || env[key]) continue
      env[key] = value
      loaded.push(key)
    }
  }

  const missing = MANAGED_KEYS.filter((key) => !env[key])
  if (missing.length === 0) return { path, loaded, created: [], missing: [] }

  const reason = skipReason(options.argv, env)
  if (reason) return { path, loaded, created: [], missing: [...missing], manualReason: reason }

  const additions: Record<string, string> = {}
  if (!env.ATR_CAPTCHA_HMAC_KEY) additions.ATR_CAPTCHA_HMAC_KEY = randomBytes(32).toString('hex')
  if (!env.ATR_ADMIN_USERNAME) additions.ATR_ADMIN_USERNAME = LOCAL_ADMIN_USERNAME
  if (!env.ATR_ADMIN_PASSWORD) additions.ATR_ADMIN_PASSWORD = randomBytes(16).toString('base64url')
  for (const [key, value] of Object.entries(additions)) env[key] = value
  writeEnvFile(path, additions)
  return { path, loaded, created: Object.keys(additions), missing: [] }
}

/** 不自动生成的原因；返回 undefined 表示「本机自用，可以生成」。 */
function skipReason(argv: readonly string[], env: Record<string, string | undefined>): string | undefined {
  if (argv.includes('-h') || argv.includes('--help')) return '这次只是打印 --help'
  const host = flagValue(argv, '--host') ?? '127.0.0.1'
  if (!LOOPBACK_HOSTS.has(host)) return `监听地址是 ${host}，不是回环地址`
  const mysql = flagValue(argv, '--mysql') ?? env.ATR_MYSQL_URL
  if (mysql) return '上报库配成了 MySQL（共享 / 生产库不落本地口令）'
  return undefined
}

/** 取 `--flag value` 的值（`=` 写法与 main.ts 的解析保持一致：不支持）。 */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  if (i < 0) return undefined
  const value = argv[i + 1]
  return value && !value.startsWith('--') ? value : undefined
}

/** 只补缺失的键，**保留**文件里其余的行与注释。 */
function writeEnvFile(path: string, additions: Record<string, string>): void {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [...HEADER]
  const written = new Set<string>()
  const body = lines.map((line) => {
    const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]
    if (!key || !(key in additions)) return line
    written.add(key)
    return `${key}=${additions[key]}`
  })
  for (const [key, value] of Object.entries(additions)) if (!written.has(key)) body.push(`${key}=${value}`)
  while (body.length > 0 && (body[body.length - 1] ?? '').trim() === '') body.pop()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body.join('\n') + '\n', 'utf8')
  // 文件里有明文初始化口令：POSIX 上收紧权限（Windows 不做 chmod）
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600)
    } catch {
      // 权限收紧失败不该挡住启动（文件仍然可用）
    }
  }
}
