/**
 * HTTP 响应信封 —— `{ ok: false, reason }` 的**唯一**生成点。
 *
 * ## 为什么必须收在一处
 *
 * 重构前这个字面量手写了约 31 次（`index.ts` 12 处、`stats-route.ts` 12 处、
 * `ingest-route.ts` 3 处、`local-api.ts` 2 处、`admin-route.ts` 2 处）。
 * 它看起来「只是拼个对象」，但它是**线上契约**：前端与 CLI 都按
 * `reason` 直接展示。散着写的结果是文案与 Content-Type 会缓慢漂移，
 * 而这类漂移不会报错，只会让某个端点的报错在页面上变难看或者变成 `undefined`。
 *
 * ## ★ 状态码的语义**不在这里**决定
 *
 * 这里只负责「怎么把话写出去」。**谁该是 401 / 403 / 503 / 200+ok:false**
 * 由各路由决定，且有三族刻意相反的约定（见 `ARCHITECTURE.md` §5 与
 * `admin-route.ts` 文件头）：
 *
 * | 端点族 | 鉴权失败 |
 * |---|---|
 * | `/api/v1/token-usage`（上报） | **401 / 503** —— 客户端把 2xx 当「已投递」并清 pending |
 * | `/api/v1/stats/*`（看板） | **401 / 503** —— 响应体里装的是数据，2xx 会被读成「没人用」 |
 * | `/api/v1/admin/members*`（管理） | **401 / 403 / 503** —— 响应体里装的是名单与 token |
 * | `/api/v1/identity/verify`、`/api/local/identity` | **200 + ok:false** —— 业务结果，不是 HTTP 错误 |
 *
 * 把这些差异「统一」掉是本仓最不能接受的一类改动。
 */

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

/** 成功/任意 JSON 响应。 */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': JSON_CONTENT_TYPE },
  })
}

/** 失败信封 `{ ok:false, reason }`。默认 400（请求形状错误）。 */
export function fail(reason: string, status = 400): Response {
  return json({ ok: false, reason }, status)
}

/**
 * 405 —— **必须带 `Allow` 头**。
 *
 * 客户端的重试逻辑会读它；`e2e-ingest.ts` 逐字断言 `Allow === 'POST'`。
 */
export function methodNotAllowed(allow: string): Response {
  return new Response(JSON.stringify({ ok: false, reason: '方法不允许' }), {
    status: 405,
    headers: { 'Content-Type': JSON_CONTENT_TYPE, Allow: allow },
  })
}

/** 路由类的返回形状（`{ status, body }`）→ `Response`。 */
export interface RouteResult {
  status: number
  body: unknown
}

/** 把路由结果转成 `Response`。 */
export function respond(result: RouteResult): Response {
  return json(result.body, result.status)
}

/** 兜底错误文案里的人类可读原因。 */
export function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}