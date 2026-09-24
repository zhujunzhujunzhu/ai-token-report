/**
 * HTTP 请求包装 —— 本地服务的所有 API 都走这里。
 *
 * ## 错误处理原则
 *
 * 网络失败**不抛异常**，而是返回带 `error` 的结果对象。
 * 页面据此展示「无法连接本地服务」而不是白屏 —— 用户此时最需要知道发生了什么。
 *
 * 把所有失败都收进 `ApiResult`，页面里就不用到处 try/catch，
 * 也不会出现「某个分支忘了处理异常导致整个视图挂掉」这种问题。
 */

/** 本地服务的基地址。同源部署时为空字符串即可。 */
const BASE = ''

/** 统一的结果包装。 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string }

export async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })

    const text = await res.text()
    let parsed: unknown = null
    if (text.trim()) {
      try {
        parsed = JSON.parse(text)
      } catch {
        return { ok: false, error: `服务端返回了非 JSON 响应（HTTP ${res.status}）` }
      }
    }

    if (!res.ok) {
      const reason =
        parsed && typeof parsed === 'object' && 'reason' in parsed
          ? String((parsed as { reason: unknown }).reason)
          : `HTTP ${res.status}`
      return { ok: false, error: reason }
    }

    return { ok: true, data: parsed as T }
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error && err.name === 'TypeError'
          ? '无法连接本地服务，请确认 dsh-token --web 仍在运行'
          : err instanceof Error
            ? err.message
            : String(err),
    }
  }
}