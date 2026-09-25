/**
 * `node:http` 服务适配器 —— 让部门服务端与本地页面服务**不依赖 `Bun.serve`**。
 *
 * ## 为什么需要一个适配器而不是重写一套路由
 *
 * `index.ts` 里的请求处理器**本来就写成 Web 标准的**
 * （入参 `Request`、返回 `Response`），Bun 专有的只有最外面那层
 * `Bun.serve({ fetch: handler })`。所以这里只做「把 Node 的
 * `IncomingMessage`/`ServerResponse` 翻译成 `Request`/`Response`」，
 * **路由、鉴权、口径一行都不用动**，两条运行时也就天然共享同一套逻辑。
 *
 * ★ 这是刻意的取舍：若为 Node 另写一套路由，就会存在第二个「什么路径返回什么」
 *   的实现，而它与 Bun 那套必然随时间漂移 —— 这类分叉不会报错，
 *   只会让某个端点在某个运行时上悄悄返回不一样的东西。
 *
 * ## 为什么把请求体整个读进内存
 *
 * 本服务的请求体都是小 JSON（署名、token 校验、一批上报），几百字节到几 MB 量级；
 * 而提交 `ReadableStream` 作为 `Request` 的 body 需要额外处理 Node 的
 * `duplex: 'half'` 约束，容易在边界上出错。用内存换确定性是划算的。
 * ⚠️ 上报接口另有一个 32 MiB 的 `Content-Length` 上限（见 `index.ts`），
 *   将来要支持更大的上传必须改成流式，不能沿用现在的写法。
 *
 * ## 🚨 `node:http` 必须**动态** import
 *
 * 这个模块只在 Node 上被调用（Bun 走 `Bun.serve`），但静态 import 会让
 * `node:http` 在 **Bun 上也被求值** —— 而它在被求值的那一刻就会构造
 * `http.globalAgent`，后者要解析 `HTTP_PROXY` / `http_proxy`：
 *
 * ```
 * Invalid proxy URL: http://127.0.0.1:10809      code: ERR_PROXY_INVALID_CONFIG
 *   at parseProxyUrl (internal:http) → new Agent (node:_http_agent) → node:http
 * ```
 *
 * 实测（Windows + Bun 1.4.2）：代理环境变量末尾带一个 CRLF 就会触发，
 * 且**整个服务起不来** —— 表现是 `bun run server` 直接崩在 import 阶段，
 * 连一行启动日志都没有，而错误信息完全不提代理是从哪来的。
 * 把 import 挪进函数体（那时已经确定跑在 Node 上）即可绕开：
 * 适配器的静态依赖里不该有它根本用不到的运行时。
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** 一个已启动的 HTTP 服务（两个运行时的公共形状）。 */
export interface ServeHandle {
  /** 实际监听的端口（可能因占用而后移）。 */
  port: number
  /** 优雅停机。 */
  stop(): Promise<void>
}

/** 请求处理器：与 `Bun.serve` 的 `fetch` 完全同形。 */
export type RequestHandler = (req: Request) => Response | Promise<Response>

/** 在指定端口上监听；端口被占用时抛出的错误交给调用方识别。 */
function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: unknown): void => {
      server.removeListener('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/** 关闭一个已启动的服务并等它真的关完。 */
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve())
    // keep-alive 连接会让 close() 一直不回调，这里主动断开空闲连接。
    // ⚠️ 不要用 closeAllConnections()：它会掐断正在返回的响应。
    server.closeIdleConnections?.()
  })
}

/**
 * 用 `node:http` 起一个服务。
 *
 * 端口占用重试由调用方（`index.ts` 的 `serveWithPortRetry`）统一负责，
 * 因为 Bun 那一侧是同步抛错、Node 这一侧是异步 reject ——
 * 把差异收敛在那一个函数里，比让两边各自实现一遍重试更不容易出错。
 */
export async function serveWithNodeHttp(options: {
  host: string
  port: number
  /** 请求超时（秒）。与 `Bun.serve` 的 `idleTimeout` 对齐语义。 */
  idleTimeoutSeconds: number
  handler: RequestHandler
}): Promise<ServeHandle> {
  const { host, port, handler } = options

  // 🚨 动态 import，理由见文件头（静态 import 会让 Bun 上也在 import 期崩掉）
  const { createServer } = await import('node:http')

  const server = createServer((req, res) => {
    void handleNodeRequest(req, res, handler, host, port)
  })

  /**
   * ⚠️ 必须显式设置，理由与 `Bun.serve` 的 `idleTimeout` 完全相同：
   *   首次冷建库要约 15 秒，超时太短会让客户端看到 `ECONNRESET`
   *   而**服务端一条日志都没有**。
   *   Node 的 `requestTimeout` 默认是 300 秒（够用），但显式写出来
   *   才能让「这里有意放长」这件事被下一个改代码的人看见。
   */
  server.requestTimeout = options.idleTimeoutSeconds * 1000
  server.headersTimeout = options.idleTimeoutSeconds * 1000

  await listen(server, host, port)

  return {
    port,
    stop: () => closeServer(server),
  }
}

/** 把 Node 的请求/响应翻译成 Web 标准的 `Request`/`Response`。 */
async function handleNodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handler: RequestHandler,
  host: string,
  port: number,
): Promise<void> {
  try {
    const method = req.method ?? 'GET'

    // 把请求体读完再构造 Request（见文件头「为什么把请求体整个读进内存」）
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    const hasBody = chunks.length > 0 && method !== 'GET' && method !== 'HEAD'

    // 用 Host 头拼绝对 URL，这样 `new URL(req.url)` 在处理器里拿到的主机名
    // 与客户端请求的一致（回调地址、日志排障都要靠它）。
    const hostHeader = req.headers.host ?? `${host}:${port}`
    const url = `http://${hostHeader}${req.url ?? '/'}`

    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      if (Array.isArray(value)) for (const v of value) headers.append(key, v)
      else headers.set(key, value)
    }

    const request = new Request(url, {
      method,
      headers,
      ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
    })

    const response = await handler(request)

    const outHeaders: Record<string, string | string[]> = {}
    response.headers.forEach((value, key) => {
      if (key !== 'set-cookie') outHeaders[key] = value
    })
    // 登录会同时清除验证码 Cookie、写入会话 Cookie。逐项赋值会覆盖前一项，
    // 逗号合并也不是合法的 Set-Cookie；Node 必须使用数组保留独立响应头。
    const cookies = response.headers.getSetCookie()
    if (cookies.length) outHeaders['set-cookie'] = cookies

    // 两个运行时的 Response 都支持 arrayBuffer()，用它统一取值，
    // 避免依赖 Node 特有的 Readable.fromWeb 桥接。
    const body = Buffer.from(await response.arrayBuffer())
    res.writeHead(response.status, outHeaders)
    res.end(body)
  } catch (err) {
    // 兜底：任何未捕获异常都返回 JSON 而不是让连接挂断 ——
    // 与 `index.ts` 处理器内的兜底保持同一策略，前端才能拿到结构化错误。
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
    }
    res.end(
      JSON.stringify({
        ok: false,
        reason: `服务内部错误: ${err instanceof Error ? err.message : String(err)}`,
      }),
    )
  }
}
