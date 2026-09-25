/**
 * 部门后台 HTTP 边界。GET 与 POST 共用解析、超时及鉴权头逻辑，
 * HTTP 错误和 200 + ok:false 的业务结果保持分开，由各业务 Store 处理。
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number }

async function send<T>(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, {
      method,
      signal: AbortSignal.timeout(20_000),
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Portal-Request': '1',
      },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return {
        ok: false,
        status: response.status,
        error: `服务端返回了非 JSON 响应（HTTP ${response.status}），请确认后端与开发代理配置`,
      }
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error:
          parsed && typeof parsed === 'object' && 'reason' in parsed
            ? String(parsed.reason)
            : `请求失败（HTTP ${response.status}）`,
      }
    }
    // 本站接口均返回对象；空响应不能当成功，否则页面会在读取字段时白屏。
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        status: response.status,
        error: '服务端返回了无效的数据，请稍后重试',
      }
    }
    return { ok: true, data: parsed as T }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error:
        error instanceof Error && error.name === 'TimeoutError'
          ? '请求超时，请稍后刷新重试'
          : '无法连接部门服务端，请确认服务端仍在运行',
    }
  }
}

export function request<T>(path: string): Promise<ApiResult<T>> {
  return send<T>(path, 'GET')
}

export function post<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  return send<T>(path, 'POST', body)
}
