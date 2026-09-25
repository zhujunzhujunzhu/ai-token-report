/**
 * 请求体：上限与 JSON 读取 —— 所有端点共用一份实现。
 *
 * ## 重构前的状态（这是本次收编的主要对象之一）
 *
 * 同一个动作有 **4 条不同的代码路径**，语义还各不相同：
 *
 * | 位置 | 写法 | 空 body / 非法 JSON |
 * |---|---|---|
 * | 上报 | `await req.json()` | 400「不是合法 JSON」 |
 * | `identity/verify` | `await req.json()` 包在 try 里 | **静默忽略**，改看 `Authorization` 头 |
 * | 本地署名 | `await req.json()` | 400 |
 * | 人员管理 | `readJsonBody()`（`text()` + `JSON.parse`） | 空 body 合法 → `value: null` |
 *
 * 四种都是「对的」，但它们是**四个实现**。这里保留两种策略
 * （`strict` / `lenient`）并让它们共用同一个解析函数 ——
 * 策略差异是业务语义，实现差异不是。
 *
 * ## ★ 上限依然刻意给足（32 MiB）
 *
 * 一条上报记录约 300 字节，32 MiB 够放十万条。被这个上限挡下的批次在客户端
 * **不会消失**，而是保留 `pending` 反复重试（见 `cli/src/report.ts`），
 * 所以它必须只挡「明显异常」的请求体 —— 调小它等于让正常批次永远送不上来。
 */

import { bodyLimit } from 'hono/body-limit'
import type { Context, MiddlewareHandler } from 'hono'

import { fail } from './envelope.js'

/** 请求体上限（字节）。理由见文件头。 */
export const MAX_BODY_BYTES = 32 * 1024 * 1024

/** 超限文案（`e2e`/契约测试逐字断言，别改）。 */
export const BODY_TOO_LARGE_REASON = '请求体过大（上限 32 MiB）'

/** 非法 JSON 文案（同上）。 */
export const BAD_JSON_REASON = '请求体不是合法 JSON'

/**
 * 全局请求体上限中间件。
 *
 * ★ 为什么用库而不是继续在 handler 里判 `Content-Length`：
 *   重构前只有上报接口有上限，其余三个 POST 端点**一个都没有**；
 *   而手写的那种只看头，`Transfer-Encoding: chunked` 的请求体绕得过去。
 *   库这版在两种情况下都拦（头缺失时真去数字节），并且对没有 body 的
 *   请求直接放行（见 `hono/body-limit` 的实现）。
 *
 * ⚠️ 文案必须保持我们自己的形状：库默认返回纯文本 `Payload Too Large`，
 *   而前端拿它当 `reason` 展示 —— 这里用 `onError` 换回统一信封。
 */
export function requestBodyLimit(): MiddlewareHandler {
  return bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => fail(BODY_TOO_LARGE_REASON, 413),
  })
}

/** body 读取结果：`{ value }` 或 `{ error }`（而不是抛异常）。 */
export type BodyRead = { value: unknown } | { error: string }

/**
 * 严格读取：空 body 也算「不是合法 JSON」。
 *
 * 用于上报与本地署名 —— 这两个端点的请求体是**必需**的，
 * 空 body 是客户端 bug，必须当场说清楚（而不是在下游报一个
 * 让人以为「字段没填对」的形状错误）。
 */
export async function readJsonBodyStrict(c: Context): Promise<BodyRead> {
  const text = await c.req.text()
  if (!text.trim()) return { error: BAD_JSON_REASON }
  return parseJsonText(text)
}

/**
 * 宽松读取：空 body 合法，返回 `{ value: null }`。
 *
 * 用于人员管理 —— 它的形状校验在下游（`admin-route.ts`），
 * 由那里给出「请求体需要是一个对象」这类更准确的提示。
 */
export async function readJsonBodyLenient(c: Context): Promise<BodyRead> {
  const text = await c.req.text()
  if (!text.trim()) return { value: null }
  return parseJsonText(text)
}

/** 唯一的 `JSON.parse` 调用点。 */
function parseJsonText(text: string): BodyRead {
  try {
    return { value: JSON.parse(text) }
  } catch {
    return { error: BAD_JSON_REASON }
  }
}