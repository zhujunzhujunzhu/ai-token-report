/**
 * `pricing sync` —— 从部门服务端拉一份只读单价快照，落到本地数据目录。
 *
 * ## 为什么是「快照」而不是每次统计都问服务端
 *
 * 本机路径（CLI / 本地页 / 插件宿主）必须能在**断网**时回答「大概花了多少」，
 * 而单价是全局配置、变化极少。把它同步成一份文件既满足离线，也不必在每次统计时
 * 发请求。代价是这份文件会**过期** —— 所以快照里必须存 `syncedAtMs`，展示层
 * 必须把它打出来（见 `cost-view.ts` 的 `describeProvenance()`）。
 *
 * ## 接口与权限
 *
 * 走 `GET <portal>/api/v1/stats/pricing`，门是 **`cost:read`**。
 * 它与管理接口 `/api/v1/admin/pricing`（门是 `pricing:manage`）是两条接口两道门：
 * 那条是**配置**，这条是「看数据时的解释材料」。
 *
 * 🚨 2026-10 起 **appKey（插件 / CLI 上报用的那把）也带 `cost:read`** ——
 *   插件面板要按**线上那份价**算金额，而它手上只有 appKey（见 `APP_KEY_SCOPES`）。
 *   所以这条命令用 appKey 也跑得通。仍然推荐用后台账号**专用只读凭证**
 *   （范围最小、可单独吊销、不影响上报）；改价仍然是 `pricing:manage` 的事。
 *   403 的信息量必须足够大 —— 否则使用者会以为是「服务端没装好」。
 *
 * ## 为什么不在这里校验字段
 *
 * 线上 `prices` 是 snake_case，转内存形态走 `shared/price.ts` 的
 * `modelPriceFromWire()` —— 自己写一遍字段映射就等于第二份「NULL 怎么处理」的实现
 * （把 `effective_to_ms = NULL` 读成 `0`，那条价从此匹配不上任何事件，
 * 而金额看起来只是「少算了点」）。写盘前再用**读取方的那个解析器**回读一遍，
 * 保证「同步报成功」与「本地真的能按它算」是同一件事。
 */

import {
  loadLocalPricing,
  resolvePricingPath,
  writePricingSnapshot,
} from '@ai-token-report/core/db'
import {
  modelPriceFromWire,
  parsePricingSnapshot,
  type ModelPrice,
  type PricingSnapshot,
} from '@ai-token-report/shared'

/** `pricing sync` 的完整用法（缺参数时逐字打印，避免「只报一个错、不知道怎么改」）。 */
export const PRICING_SYNC_USAGE = `
用法:
  ai-token-report pricing sync --portal <部门服务端根地址> --token <带 cost:read 的凭证>

参数:
  --portal <url>   部门服务端**根地址**（如 http://host:8787），与 web 的 --portal 同一个语义
  --token <t>      带 cost:read 的凭证：appKey（插件 / CLI 上报用的那把）**也带这个范围**，
                   或用后台账号签发的专用只读凭证
  --data-dir <p>   数据目录（快照缺省落在 <data-dir>/pricing.json）
  --pricing-file <p>  指定快照文件路径（覆盖上面的缺省）

说明:
  拉取 GET <portal>/api/v1/stats/pricing，把返回的单价写成一份本地快照；
  之后 CLI 的 --cost、本地页与插件宿主都按这份快照算金额（与看板同源）。
  ★ 没有快照时它们**一位金额都不显示**（如实标成「未计价」）——
    本仓不再有任何内置价目表，所以绝不会有「没配也能出一个数」的情况。
`.trim()

export interface PricingSyncOptions {
  /** 部门服务端**根地址**（如 `http://host:8787`）。 */
  portal: string
  /** 凭证（可带 `Bearer ` 前缀）。 */
  token: string
  dataDir?: string
  /** 显式指定快照文件；给了就不用数据目录下的缺省名。 */
  pricingFile?: string
  /** 单次请求超时（毫秒），默认 15s。 */
  timeoutMs?: number
  /** 注入用，便于测试；默认用全局 fetch。 */
  fetchImpl?: typeof fetch
}

export interface PricingSyncSuccess {
  ok: true
  /** 落盘路径。 */
  path: string
  /** 条数。 */
  count: number
  /** 完整的目标 URL（写进快照，用于排障）。 */
  endpoint: string
  syncedAtMs: number
  /**
   * 非致命的提醒（如「服务端一条价都没配」）。
   *
   * 不是失败：空单价表与看板是**一致**的（两边都全未计价），此时退回内置价
   * 反而会让两个形态给出不同的金额。
   */
  warnings: string[]
}

export interface PricingSyncFailure {
  ok: false
  /** 进程退出码：`2` = 参数错误，`1` = 运行期失败。 */
  code: 1 | 2
  message: string
}

/** 拼出统计侧单价快照的完整 URL（根地址的尾斜杠与 `server/src/identity-route.ts` 同一处理）。 */
export function pricingEndpointOf(portal: string): string {
  return `${portal.replace(/\/+$/, '')}/api/v1/stats/pricing`
}

/** 校验 `--portal`：必须是 http/https 的根地址，否则回一个参数错误而不是让 fetch 抛 URL 解析错误。 */
export function validatePortal(portal: string): string | null {
  let url: URL
  try {
    url = new URL(portal)
  } catch {
    return `--portal 需要形如 http://host:8787 的完整地址，收到 "${portal}"`
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `--portal 只支持 http / https，收到 "${url.protocol}"`
  }
  return null
}

/** 从错误响应里取「服务端说了什么」；不是 JSON（网关 HTML 页等）就退回原文。 */
function reasonOf(raw: string): string {
  const text = raw.trim()
  if (!text) return ''
  try {
    const parsed = JSON.parse(text) as { reason?: unknown }
    if (parsed && typeof parsed.reason === 'string' && parsed.reason) return parsed.reason
  } catch {
    // 不是 JSON：继续用原文（截断），比「响应无法解析」有用得多
  }
  return text.slice(0, 300)
}

export async function syncPricing(
  options: PricingSyncOptions,
): Promise<PricingSyncSuccess | PricingSyncFailure> {
  const portalError = validatePortal(options.portal)
  if (portalError) return { ok: false, code: 2, message: portalError }

  const endpoint = pricingEndpointOf(options.portal)
  // 与 `report` 同一条剥前缀的规则（`/^Bearer\s*/i`）：只有 `Bearer ` 而没有值
  // 必须落到「参数错误」，否则会发出一个 Authorization 头是 `Bearer ` 的请求 ——
  // 那会得到一个 401，而真正的原因是命令行少抄了一段。
  const token = options.token.trim().replace(/^Bearer\s*/i, '').trim()
  if (!token) return { ok: false, code: 2, message: '--token 不能是空的（也不接受只有 "Bearer" 前缀）' }

  const timeoutMs = options.timeoutMs ?? 15_000
  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let res: Response
  let raw: string
  try {
    res = await doFetch(endpoint, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    // 收到响应头不代表收到 body；超时必须覆盖 body，否则网关半响应会永久挂住。
    raw = await res.text()
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError'
      ? `请求超时（${timeoutMs}ms）`
      : err instanceof Error ? err.message : String(err)
    return { ok: false, code: 1, message: `拉取单价失败: ${reason}\n  目标 ${endpoint}` }
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const detail = reasonOf(raw)
    const tail = detail ? `\n  服务端说: ${detail}` : ''
    if (res.status === 401) {
      return {
        ok: false,
        code: 1,
        message:
          `凭证无效（HTTP 401）：服务端不认这份 token。${tail}\n` +
          '  检查 --token 是否抄错 / 是否已被吊销或过期。',
      }
    }
    if (res.status === 403) {
      return {
        ok: false,
        code: 1,
        message:
          `这份凭证没有 cost:read 权限（HTTP 403）。${tail}\n` +
          '  单价快照走 GET /api/v1/stats/pricing，门是 cost:read。\n' +
          '  appKey（插件 / CLI 上报用的那把）**带这个范围**，所以它本该能过；\n' +
          '  拿到 403 多半是这把 key 签发于更早的版本 —— 让管理员重签一把。\n' +
          '  也可以用后台账号签发、并带 cost:read 的凭证；\n' +
          `  或从别的机器手工拷贝一份 pricing.json 到数据目录。`,
      }
    }
    return { ok: false, code: 1, message: `拉取单价失败: HTTP ${res.status}${tail}\n  目标 ${endpoint}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      ok: false,
      code: 1,
      message:
        `响应不是有效 JSON（目标 ${endpoint}）。\n` +
        '  常见原因: 地址写成了前端页面地址（返回 HTML），或中间有代理插入了内容。',
    }
  }
  const rows = (parsed as { prices?: unknown } | null)?.prices
  if (!Array.isArray(rows)) {
    return { ok: false, code: 1, message: `响应缺少 prices 数组（目标 ${endpoint}），拒绝写入快照。` }
  }

  const prices: ModelPrice[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      return { ok: false, code: 1, message: '响应里的单价行不是对象，拒绝写入快照。' }
    }
    prices.push(modelPriceFromWire(row as Parameters<typeof modelPriceFromWire>[0]))
  }

  const syncedAtMs = Date.now()
  const snapshot: PricingSnapshot = { syncedAtMs, endpoint, prices }

  // ★ 写盘前用**读取方的那一个解析器**回读一遍：字段缺失 / 类型不对会让整份快照在
  //   `parsePricingSnapshot()` 那里被整份拒绝，而那时同步已经报过成功 ——
  //   使用者会以为金额已与看板对齐，实际一位金额都算不出来（最难排查的一种）。
  //   这里刻意不复刻校验规则，只复用同一个函数。
  if (parsePricingSnapshot(JSON.stringify(snapshot)) === null) {
    return {
      ok: false,
      code: 1,
      message:
        '服务端返回的单价字段不完整或类型不对（写盘前校验未通过），已拒绝写入快照。\n' +
        '  这通常意味着服务端版本与本地 CLI 不匹配，请先升级服务端。',
    }
  }

  const path = resolvePricingPath({
    dataDir: options.dataDir,
    ...(options.pricingFile ? { file: options.pricingFile } : {}),
  })
  if (path === null) {
    return {
      ok: false,
      code: 2,
      message: '无法确定快照落盘路径：请给 --data-dir 或 --pricing-file。',
    }
  }

  try {
    writePricingSnapshot(path, snapshot)
  } catch (err) {
    return {
      ok: false,
      code: 1,
      message: `写入快照失败: ${err instanceof Error ? err.message : String(err)}\n  路径 ${path}`,
    }
  }

  const warnings: string[] = []
  if (prices.length === 0) {
    warnings.push(
      '服务端当前一条单价都没配：这份快照是空的，本地金额会**全部**显示为「未计价」' +
        '（与看板一致 —— 一条价都没有就是没有金额，本仓不再有任何内置价目表）。',
    )
  }
  // 落盘后再确认一次「本地真的能按它算」：写入是原子替换，但路径可能被换成不可读的
  // 位置（权限、目录而非文件）。同步报成功而本地读不到，是这条链路上最坏的结果。
  const verify = loadLocalPricing({ file: path })
  // ⚠️ 空快照读回来是 `'none'`（一条价都没有 = 没有金额），那是**预期**，不是失败。
  const verified = verify.provenance.pricingSource === 'snapshot'
    || (verify.provenance.pricingSource === 'none' && prices.length === 0 && verify.path === path)
  if (!verified) {
    return {
      ok: false,
      code: 1,
      message:
        `快照已写入但读不回来（${path}），本地一位金额都算不出来。\n` +
        `  回读结果: ${verify.note ?? '来源不是 snapshot'}`,
    }
  }
  return { ok: true, path, count: prices.length, endpoint, syncedAtMs, warnings }
}