#!/usr/bin/env bun
/**
 * 部门服务端独立启动入口。
 *
 * 用法：
 * ```bash
 * bun run start -- --host 0.0.0.0 --port 8787
 * ```
 *
 * ⚠️ 与本地模式（`dsh-token --web`）的区别：
 * 本地模式默认只监听 127.0.0.1 且**不启用** `/api/local/*` 的对外暴露；
 * 这里是要给全组访问的，`--host 0.0.0.0` 时**必须**已有凭证，
 * 否则任何人都能读全员数据。
 */

import { resolvePaths } from '@ai-token-report/core'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createServer, DEFAULT_PORT } from './index.js'

interface Args {
  port: number
  host: string
  dshHome?: string
  dbPath?: string
  /** 上报库改用 MySQL 的连接串（也可用环境变量 `ATR_MYSQL_URL`）。 */
  mysqlUrl?: string
  credentialsPath?: string
  staticDir?: string
  portalUrl?: string
}

function parseArgs(argv: string[]): Args | null {
  const args: Args = { port: DEFAULT_PORT, host: '127.0.0.1' }
  const take = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} 需要一个值`)
    return v
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    switch (a) {
      case '-h':
      case '--help':
        return null
      case '--port': {
        const n = Number(take(i, a))
        if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error('--port 需要 1~65535')
        args.port = n
        i++
        break
      }
      case '--host':
        args.host = take(i, a)
        i++
        break
      case '--dsh-home':
        args.dshHome = take(i, a)
        i++
        break
      case '--db':
        args.dbPath = take(i, a)
        i++
        break
      case '--mysql':
        // ★ 两者只该有一个：都给了也不报错，`openPortalStore()` 的语义是
        //   「有 mysqlUrl 就用它」，`--db` 退化成不被使用的退路。
        args.mysqlUrl = take(i, a)
        i++
        break
      case '--credentials':
        throw new Error('--credentials 已停用；旧凭证文件须先通过显式数据库迁移导入')
      case '--static':
        args.staticDir = take(i, a)
        i++
        break
      case '--portal':
        args.portalUrl = take(i, a)
        i++
        break
      default:
        throw new Error(`未知参数 "${a}"`)
    }
  }
  return args
}

const HELP = `
ai-token-report 部门服务端

用法:
  bun run start [选项]

选项:
  --port <n>          监听端口 (默认 ${DEFAULT_PORT}，被占用自动 +1)
  --host <addr>       监听地址 (默认 127.0.0.1，对全组开放用 0.0.0.0)
  --dsh-home <p>      DSH home (默认 $DSH_HOME 或 ~/.dsh)
  --db <p>            上报库路径 (默认 <dsh-home>/token-report/portal.sqlite)
  --mysql <url>       上报库改用 MySQL，如 mysql://user:pass@host:3306/ai_token_report
                      (也可用环境变量 ATR_MYSQL_URL；Bun 与 Node 均支持。
                       本机库 usage.sqlite 不受影响，永远是 SQLite)
  --static <p>        部门看板前端构建产物目录 (默认 packages/web-portal/dist)
  --portal <url>      部门服务端自身地址 (本地模式用)
  -h, --help          显示帮助

数据库身份初始化:
  配置 ATR_ADMIN_USERNAME、ATR_ADMIN_PASSWORD（12～128 位）。
  ATR_ADMIN_TOKEN 可选，仅在确实需要初始化管理 API 凭证时配置。
  ATR_ADMIN_NAME 可选。使用用户名 + 密码 + 图形验证码进入管理页。
  这些值只在空数据库初始化一次；以后以数据库为准，停用身份不会因重启复活。
  ATR_CAPTCHA_HMAC_KEY 必须在所有实例保持一致；未配置时后台登录返回 503。
  旧 v3 库和 credentials.json 必须显式迁移，服务不会自动改写旧业务库。
  HTTPS 反向代理请配置 ATR_PORTAL_ORIGIN=https://你的域名。
  详见 docs/数据库部署与迁移.md。
`

async function main(): Promise<number> {
  let args: Args | null
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`错误: ${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }

  if (!args) {
    process.stdout.write(HELP)
    return 0
  }

  const paths = resolvePaths(args.dshHome)

  // 看板前端产物：显式 --static 优先，否则按仓库布局探测。
  // ⚠️ 探测不到时**不把不存在的目录传给服务**（否则每个页面请求都会去读一个
  //   不存在的 index.html 再回落到 JSON 404，排障时看不出是「没构建」），
  //   而是明确提示跑哪条命令。
  const staticDir = args.staticDir ?? resolvePortalDist()

  const handle = await createServer({
    port: args.port,
    host: args.host,
    ...(args.dshHome ? { dshHome: args.dshHome } : {}),
    ...(args.dbPath ? { dbPath: args.dbPath } : {}),
    ...(args.mysqlUrl ? { mysqlUrl: args.mysqlUrl } : {}),
    ...(args.credentialsPath ? { credentialsPath: args.credentialsPath } : {}),
    ...(staticDir ? { staticDir } : {}),
    ...(args.portalUrl ? { portalUrl: args.portalUrl } : {}),
    enableLocalApi: false,
  })

  const out: string[] = []
  out.push(`部门服务端已启动  ${handle.url}`)
  if (handle.portShifted) {
    out.push(`  ⚠ 端口 ${args.port} 被占用，已改用 ${handle.port}`)
  }
  out.push(`  DSH home  ${paths.dshHome}`)
  out.push(`  身份存储  数据库 v${handle.schemaVersion}（${handle.initialized ? '已初始化' : '待初始化'}）`)
  out.push(`  有效凭证  ${handle.credentialCount} 枚，可用管理员 ${handle.adminCount} 人`)
  // 上报库必须打印出来：它是全员数据的唯一副本，出问题时管理员要知道去备份哪个库。
  // ★ 用 handle 里的描述而不是自己拼路径：配了 MySQL 时它要打印「库名 @ 主机:端口」，
  //   而且**必须脱敏**（`ATR_MYSQL_URL` 里带密码，启动日志经常被贴进工单）。
  out.push(`  上报库    ${handle.portalTargetLabel}`)
  out.push(`  上报接口  POST ${handle.url}/api/v1/token-usage`)
  if (staticDir) {
    out.push(`  部门看板  ${handle.url}/  （资源 ${staticDir}）`)
    out.push(`  人员管理  ${handle.url}/ →「人员管理」页（需管理员登录账号）`)
  } else {
    out.push(`  ⚠ 未找到部门看板构建产物，仅提供 API。先执行: bun run build:portal`)
  }
  // ★ 没有人是管理员时必须在启动时说清：管理页谁都进不去，
  //   而管理页的第一件事恰恰是「发放第一个 token」—— 不说就是个死锁。
  if (handle.adminCount === 0) {
    out.push('')
    out.push('  ⚠ 数据库尚未建立可用管理入口。全新部署请配置 ATR_ADMIN_USERNAME / ATR_ADMIN_PASSWORD 后启动。')
  }
  if (!args.dbPath && !args.dshHome && !args.mysqlUrl && !process.env.ATR_MYSQL_URL) {
    out.push(`  ⚠ 上报库默认落在 DSH home 下；生产部署建议用 --db 指到独立数据盘，或用 --mysql。`)
  }
  if (args.host !== '127.0.0.1') {
    out.push(`  ⚠ 正在监听 ${args.host}，内网可访问。请确认凭证已配置且已发放给员工。`)
  }
  out.push('')
  out.push('  Ctrl+C 停止')
  process.stdout.write(out.join('\n') + '\n')

  // 保持进程存活，直到收到中断信号
  await new Promise<void>((resolve) => {
    const stop = async (): Promise<void> => {
      process.stdout.write('\n正在停止服务...\n')
      await handle.stop()
      resolve()
    }
    process.on('SIGINT', () => void stop())
    process.on('SIGTERM', () => void stop())
  })

  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    process.stderr.write(`未处理的错误: ${err instanceof Error ? err.stack : String(err)}\n`)
    process.exitCode = 1
  })

/**
 * 探测部门看板前端的构建产物目录。
 *
 * 候选路径与 CLI 找 `web-local` 产物的做法一致（见 `packages/cli/src/cli.ts`
 * 的 `resolveWebLocalDist`）：**开发形态**从源码目录往上找，
 * **发布形态**则可能被拷进包目录旁边。这里只覆盖本仓开发形态 ——
 * 部门服务端目前只从仓库里起（`bun run server`），未随 npm 包发布。
 *
 * 返回 null 表示尚未构建（调用方给出明确提示，而不是拿空目录去托管）。
 */
function resolvePortalDist(): string | undefined {
  // 源码目录 = packages/server/src。用 fileURLToPath 而不是 Bun 专有的
  // `import.meta.dir`：本文件虽然由 bun 启动，但服务端整体要能跑在 Node 上
  // （见 index.ts 的运行时无关说明），少一处 Bun 专有 API 就少一个坑。
  const here = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [
    resolve(here, '..', '..', 'web-portal', 'dist'),
    resolve(process.cwd(), 'packages', 'web-portal', 'dist'),
  ]
  for (const dir of candidates) {
    if (existsSync(resolve(dir, 'index.html'))) return dir
  }
  return undefined
}
