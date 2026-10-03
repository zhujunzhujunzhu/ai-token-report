/**
 * 部门服务端地址的归一化 —— **全平台唯一一份**。
 *
 * ## 为什么在 shared
 *
 * 「用户填的地址」有三个入口，而它们必须得出**同一个**结论：
 *
 * | 入口 | 谁在用 |
 * |---|---|
 * | 插件面板的「连接配置」 | `dsh-plugin/src/settings.ts` |
 * | 本地页面的「配置」弹框 | `server/src/identity-route.ts` |
 * | 部署参数 `--portal` / `endpoint` | CLI / 服务端 |
 *
 * 三处各写一遍解析的后果不是「报错」，而是**同一个地址在一处被接受、在另一处被拒**，
 * 或者更糟：一处剥掉了 `/api/v1/token-usage` 后缀、另一处没剥，
 * 于是上报打到 `/api/v1/token-usage/api/v1/token-usage`。
 * 所以这里只有这一个实现，插件侧只做 re-export（见 `dsh-plugin/src/settings.ts`）。
 *
 * ## 为什么宽容
 *
 * 用户从浏览器地址栏复制的是 `http://host:8787/`，从文档复制的是
 * `http://host:8787/api/v1/token-usage`，两者都该能用 —— 容错比
 * 「格式不对，请重填」有用得多。唯一不能含糊的是**协议与凭证**：
 * 非 HTTP(S)、带账号密码、带查询串或片段一律拒绝
 * （后两者会让「上报地址」变成可被外部控制的跳转）。
 */

/** 上报路径（`baseUrl` + 它 = 上报地址）。 */
export const INGEST_PATH = '/api/v1/token-usage'

/** 身份校验路径（`baseUrl` + 它）。 */
export const VERIFY_PATH = '/api/v1/identity/verify'

/**
 * 把用户填的地址归一成**服务端根地址**（无尾斜杠、无接口后缀）。
 *
 * @throws 地址不是合法 URL，或带账号 / 查询参数 / 片段 / 非 HTTP(S) 协议。
 *   调用方**必须**接住它并回一句人话（这是用户输入，不是程序缺陷）。
 */
export function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('服务端地址必须是不含账号、查询参数或片段的 HTTP(S) 地址')
  }
  // 贴心的反向做法：用户把完整上报地址粘进来时，替他把接口后缀去掉。
  // ⚠️ 只剥这几个**已知**后缀；其它路径前缀（反代挂在 /token-report 下）
  //    必须保留，否则会把合法部署改写成根路径。
  for (const suffix of [INGEST_PATH, '/api/v1', '/api']) {
    if (url.pathname === suffix || url.pathname === `${suffix}/`) {
      url.pathname = '/'
      break
    }
    if (url.pathname.endsWith(suffix)) {
      url.pathname = url.pathname.slice(0, -suffix.length) || '/'
      break
    }
  }
  return url.toString().replace(/\/+$/, '')
}

/** 根地址 → 上报地址。 */
export function endpointOf(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl) + INGEST_PATH
}

/** 根地址 → 校验地址。 */
export function verifyUrlOf(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl) + VERIFY_PATH
}

/** 上报地址 → 根地址（读旧版配置文件用）。坏值原样返回，由界面显示出来让用户改。 */
export function baseUrlOf(endpoint: string): string {
  try {
    return normalizeBaseUrl(endpoint)
  } catch {
    return endpoint
  }
}
