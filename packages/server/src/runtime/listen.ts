/**
 * 监听层 —— 「在哪个地址起服务」这件事的**唯一**落点。
 *
 * ## ★ 两个运行时的差异只收敛在这里
 *
 * | 运行时 | 最外层 | 端口占用的表现 |
 * |---|---|---|
 * | Bun | `Bun.serve` | **同步抛错** |
 * | Node | `node:http`（`serve-node.ts` 桥接） | **异步 reject** |
 *
 * 把它包成 async 之后，重试循环对两者就是同一套写法 ——
 * 这是本仓「不给 Node 另写一套路由」那条约束的最外层体现：
 * 请求处理器本身是 Web 标准的 `Request`/`Response`，两个运行时共用同一份。
 *
 * 🚨 **静态资源一律走 `node:fs/promises`，绝不用 `Bun.file()`** ——
 *   那是 Bun 专有的，会让 npm 发布出去、跑在 Node 上的 CLI 直接崩。
 */

import { serveWithNodeHttp, type RequestHandler, type ServeHandle } from '../serve-node.js'

/** 请求处理器（与 `Bun.serve` 的 `fetch` 完全同形）。转发自 `serve-node.ts`。 */
export type { RequestHandler }

/** 默认端口。 */
export const DEFAULT_PORT = 8787

/** 端口被占用时的最大重试次数。 */
const MAX_PORT_ATTEMPTS = 10

/**
 * 空闲超时（秒）。**必须显式设置，否则 `Bun.serve` 的默认值是 10 秒。**
 *
 * 历史背景：早期本地页直扫日志，冷扫描要 10~13 秒（185 文件 / 61 MB），
 * 默认 10 秒会直接掐断连接 —— 客户端看到 `ECONNRESET`，
 * 而**服务端一条日志都没有**，表现为「本地页偶尔连不上」这种
 * 极难复现、极难定位的故障。
 *
 * 现在数据源换成了本地 SQLite 增量库，热态查询只要 20ms 左右，
 * 这个超时已经不再是正确性瓶颈。但**仍然必须设大**，因为还有两个
 * 真实的长请求场景：
 *
 * 1. **首次冷启动建库**：库不存在时要全量解析历史日志，实测约 15 秒
 * 2. **`--reset-db` 之后的第一请求**：同上
 *
 * 设为 120 秒：给冷建库留一个数量级的余量。扫描期间连接是活跃的
 * （请求尚未返回），所以真正被这个值兜住的是「客户端已断开但任务还在跑」，
 * 那种情况等久一点只是浪费一个协程，远好过误杀一个正常的长请求。
 */
export const IDLE_TIMEOUT_SECONDS = 120

/** 是否跑在 Bun 上。决定用 `Bun.serve` 还是 `node:http`。 */
export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
}

/**
 * 在指定端口起服务；端口被占用时抛出（由调用方重试）。
 *
 * ★ 两个运行时的差异**只收敛在这里**：Bun 的 `Bun.serve` 端口占用是
 *   **同步抛错**，而 `node:http` 是 **异步 reject**。把它包成 async 之后，
 *   上面的重试循环对两者就是同一套写法。
 */
async function tryListen(
  host: string,
  port: number,
  handler: RequestHandler,
): Promise<ServeHandle> {
  if (isBunRuntime()) {
    const server = Bun.serve({
      hostname: host,
      port,
      fetch: handler,
      // 见 IDLE_TIMEOUT_SECONDS 的注释：不设这个值，冷扫描必被掐断
      idleTimeout: IDLE_TIMEOUT_SECONDS,
    })
    const listeningPort = server.port
    if (listeningPort === undefined) {
      await server.stop(true)
      throw new Error('HTTP 服务启动后未返回实际监听端口')
    }
    return {
      // 端口 0 由操作系统分配；必须回传真实端口，否则调用方得到不可连接的 URL。
      port: listeningPort,
      stop: async () => {
        await server.stop(true)
      },
    }
  }

  // Node 运行时：请求处理器本身是 Web 标准的，这里只换最外面那层 server。
  return serveWithNodeHttp({
    host,
    port,
    idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
    handler,
  })
}

/** 依次尝试端口，直到绑定成功。 */
export async function serveWithPortRetry(
  host: string,
  startPort: number,
  handler: RequestHandler,
): Promise<{ handle: ServeHandle; port: number; shifted: boolean }> {
  let lastErr: unknown

  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    const port = startPort + i
    try {
      const handle = await tryListen(host, port, handler)
      return { handle, port: handle.port, shifted: i > 0 }
    } catch (err) {
      lastErr = err
      // 只有「端口占用」才重试；其他错误（如权限）应立即失败
      if (!isPortInUse(err)) {
        throw err
      }
    }
  }

  throw new Error(
    `端口 ${startPort}~${startPort + MAX_PORT_ATTEMPTS - 1} 都被占用，无法启动服务。` +
      `请用 --port 指定其他端口。原始错误：${unreadable(lastErr)}`,
  )
}

function isPortInUse(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  if (code === 'EADDRINUSE') return true
  const text = unreadable(err).toLowerCase()
  return text.includes('eaddrinuse') || text.includes('address already in use')
}

function unreadable(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
