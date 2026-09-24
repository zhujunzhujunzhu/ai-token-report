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

import { createServer, DEFAULT_PORT } from './index.js'

interface Args {
  port: number
  host: string
  dshHome?: string
  dbPath?: string
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
      case '--credentials':
        args.credentialsPath = take(i, a)
        i++
        break
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
  --db <p>            SQLite 文件路径
  --credentials <p>   凭证文件路径
  --static <p>        前端构建产物目录
  --portal <url>      部门服务端自身地址 (本地模式用)
  -h, --help          显示帮助

凭证文件格式 (credentials.json):
  [ { "token": "atr-zhangsan-9f3c", "name": "张三", "dept": "研发一部" } ]
  或
  { "张三": "atr-zhangsan-9f3c" }
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

  const handle = await createServer({
    port: args.port,
    host: args.host,
    ...(args.dshHome ? { dshHome: args.dshHome } : {}),
    ...(args.dbPath ? { dbPath: args.dbPath } : {}),
    ...(args.credentialsPath ? { credentialsPath: args.credentialsPath } : {}),
    ...(args.staticDir ? { staticDir: args.staticDir } : {}),
    ...(args.portalUrl ? { portalUrl: args.portalUrl } : {}),
    enableLocalApi: false,
  })

  const out: string[] = []
  out.push(`部门服务端已启动  ${handle.url}`)
  if (handle.portShifted) {
    out.push(`  ⚠ 端口 ${args.port} 被占用，已改用 ${handle.port}`)
  }
  out.push(`  DSH home  ${paths.dshHome}`)
  out.push(`  凭证文件  ${args.credentialsPath ?? `${paths.dshHome}/token-report/credentials.json`}`)
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