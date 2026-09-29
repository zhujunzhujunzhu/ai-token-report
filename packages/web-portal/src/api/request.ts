/**
 * 部门后台 HTTP 边界。GET 与 POST 共用解析、超时及鉴权头逻辑，
 * HTTP 错误和 200 + ok:false 的业务结果保持分开，由各业务 Store 处理。
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number }

/**
 * 把接口路径接到部署前缀上。
 *
 * 页面挂在反向代理子路径（如 `/ai-token/`）时，`fetch('/api/v1/...')` 会打到
 * **站点根**，而根路径通常属于同实例上别的应用 —— 表现为「后端返回了非 JSON
 * 响应」，实际是请求根本没到本服务。
 *
 * 前缀由 Vite 的 `base` 决定（`import.meta.env.BASE_URL`），与产物里静态资源
 * 用的是同一个值，因此两者不可能漂移。根路径部署时它是 `/`，拼接后与原来
 * 逐字相同，行为不变。
 *
 * ⚠️ 只在此处拼接：各 api 模块继续写 `/api/v1/...` 的**根相对路径**，
 *    这样调用方不必知道自己被部署在哪个子路径下。
 */
function withBase(path: string): string {
  const base = import.meta.env.BASE_URL || '/'
  if (base === '/') return path
  // base 以 `/` 结尾、path 以 `/` 开头，去掉一个斜杠避免出现 `//`
  return base.replace(/\/$/, '') + path
}

async function send<T>(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(withBase(path), {
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
