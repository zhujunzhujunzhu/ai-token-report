/**
 * 端到端接收端：起一个真实 HTTP 服务收 token 上报，把每批载荷落盘。
 *
 * ```
 * bun run packages/dsh-plugin/verify/e2e-receiver.ts [port] [outFile]
 * ```
 *
 * 用于**真实 DSH 会话**的端到端验证：把 token-report 的 endpoint 指向它，
 * 然后在 DSH 里跑一轮对话，回来看收到了什么。
 *
 * 它同时验证两件事：
 *   1. 插件真的在会话过程中采集并投递了（不是只有启动日志）
 *   2. 线上字段与 `shared` 契约逐字对齐（四个 token 列分列、event_id 幂等键）
 */

import { appendFileSync, writeFileSync } from 'node:fs'

const port = Number(process.argv[2] ?? 18787)
const outFile = process.argv[3] ?? `${process.env.TEMP ?? '.'}/atr-e2e-received.jsonl`

// 清空旧结果，让「这次收到什么」一目了然
writeFileSync(outFile, '', 'utf8')

let batches = 0
let records = 0

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname !== '/api/v1/token-usage') {
      return new Response('not found', { status: 404 })
    }

    const auth = req.headers.get('Authorization') ?? ''
    let payload: unknown
    try {
      payload = await req.json()
    } catch {
      return Response.json({ accepted: 0, duplicates: 0, rejected: 0 }, { status: 400 })
    }

    const body = payload as {
      schemaVersion?: number
      client?: { name?: string; userId?: string; userName?: string; dept?: string }
      records?: Record<string, unknown>[]
    }
    const n = body.records?.length ?? 0
    batches += 1
    records += n

    appendFileSync(
      outFile,
      JSON.stringify({
        receivedAt: new Date().toISOString(),
        authorization: auth,
        schemaVersion: body.schemaVersion,
        client: body.client,
        recordCount: n,
        records: body.records,
      }) + '\n',
      'utf8',
    )

    console.log(
      `[${new Date().toLocaleTimeString()}] 收到第 ${batches} 批：${n} 条` +
        `  auth=${auth ? 'Bearer ***' : '(无)'}` +
        `  client.name=${body.client?.name}  user=${body.client?.userName ?? '(无)'}`,
    )

    // 如实返回三个计数 —— 插件会据此更新统计
    return Response.json({ accepted: n, duplicates: 0, rejected: 0 })
  },
})

console.log('='.repeat(72))
console.log('token 上报接收端已就绪')
console.log('='.repeat(72))
console.log(`监听      http://127.0.0.1:${server.port}/api/v1/token-usage`)
console.log(`结果写入  ${outFile}`)
console.log('')
console.log('把插件的 endpoint 指向上面这个地址，然后在 DSH 里跑一轮对话。')
console.log('Ctrl+C 停止。')

const stop = (): void => {
  console.log(`\n共收到 ${batches} 批 / ${records} 条记录 → ${outFile}`)
  server.stop(true)
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)