/**
 * 部门看板 API 客户端。
 *
 * ★ 这里的接口全部对应 `shared/src/protocol.ts` 里的类型，两端共用契约：
 *   字段对不上时 `bun run typecheck` 直接编译失败，而不是等页面上
 *   看到空图表。
 *
 * ## 时间窗由服务端解析
 *
 * 页面只传具名周期（`today` / `last7d` / …），**不做任何日期换算** ——
 * 时区口径只在 `core/range.ts` 定义一处。让浏览器自己算「本月从哪天开始」
 * 等于把口径复制到第二个地方，跨天、跨时区时页面与命令行必然对不上。
 */

import type {
  BreakdownResponse,
  DiagnosticsResponse,
  GroupBy,
  OverviewResponse,
  RecordsResponse,
  SeriesResponse,
  StatsGroupsResponse,
  StatsMembersResponse,
  StatsProvidersResponse,
  StatsSourcesResponse,
} from '@ai-token-report/shared'

import { request, type ApiResult } from './request.js'

/**
 * 部门看板的筛选条件（全部是可选的，缺省 = 全部时间 + 不筛）。
 *
 * ## 时间两种给法，二选一
 *
 * - `period`：**具名周期**（`today` / `last7d` / …），由服务端用
 *   `core/range.ts` 解析成绝对时间 —— 页面不做任何日期换算
 * - `from` / `to`：**自定义区间**（epoch 毫秒）。页面顶部的「自定义」时间窗
 *   用它：那本来就是用户明确指定的两个绝对时刻，
 *   既没有「本月从哪天开始」这种口径，也不涉及时区推算
 *   （`<input type="datetime-local">` 给的就是本地墙上时间）。
 *
 * 两者同时出现时服务端以 `from`/`to` 为准（与 CLI 的 `--since/--until`
 * 覆盖 `--period` 同义）。
 */
export interface PortalFilter {
  /** 具名周期，与 CLI 的 `--period` 完全同义。 */
  period?: string
  /** 自定义区间起点（epoch 毫秒）。 */
  from?: number
  /** 自定义区间终点（epoch 毫秒，含）。 */
  to?: number
  /**
   * 供应商（多选 = OR）。
   *
   * ⚠️ 服务端对每个值仍是**子串**匹配（与 CLI 的 `--provider` 同义）：
   *   「选了什么就发什么」，页面不把选项翻译成精确匹配 —— 那会造出第二套口径。
   * ⚠️ 线上是**重复的同名参数**（`?provider=a&provider=b`），与 `member_id` /
   *   `group_id` 一致。值里出现逗号会被服务端当成两个名字（那是逗号分隔那种
   *   写法的既有语义），所以页面不做任何拼接。
   */
  providers?: string[]
  model?: string
  /**
   * 来源筛选（多选 = OR）：`dsh` / `codex` / `claude-code` / `trae` /
   * `trae-cn` / `workbuddy`。
   *
   * 🚨 与 `providers` 的语义**刻意相反**：来源是**精确匹配**（服务端
   *   `source = ?`），因为它是受控枚举 —— 子串匹配会让 `trae` 命中 `trae-cn`，
   *   而那是两个独立安装、独立账号的来源。所以这个下拉**不允许自建值**
   *   （值域来自 `/api/v1/stats/sources`，不是现敲现用）。
   */
  sources?: string[]
  /** 服务端返回的不透明归属键：人员 UUID / legacy:… / unknown。 */
  users?: string[]
  /**
   * 分组筛选：稳定 `group_id` 列表（多选 = OR）。
   *
   * ★ 与 `users` 是**两个独立参数**（`member_id` 与 `group_id` 同时出现时服务端按 AND 叠加），
   *   且语义不同：人员是精确匹配某个人，分组是把「归属该分组的人」的事件整体取出来。
   * ⚠️ 多对多下多选是 OR / 展开：同一条事件会同时计入它的人员所属的每个分组，
   *   所以两个分组筛出来的合计大于全量合计是**定义**，不是重复计数。
   */
  groups?: string[]
}

/** 把筛选条件拼成查询串（省略空值，避免发出 `?provider=` 这种噪声）。 */
function toQuery(filter: PortalFilter): string {
  const params = new URLSearchParams()
  params.set('identity_view', 'member')
  if (filter.period) params.set('period', filter.period)
  if (filter.from !== undefined) params.set('from', String(filter.from))
  if (filter.to !== undefined) params.set('to', String(filter.to))
  if (filter.model) params.set('model', filter.model)
  // 供应商是多选：同一参数重复出现，服务端按 OR 展开（协议里的 `providers?: string[]`）。
  // ⚠️ 不做 `join(',')`：一个值里带逗号时两种写法的含义不同，
  //   而页面没有理由替使用者决定那件事。
  for (const provider of new Set(filter.providers ?? [])) {
    if (provider) params.append('provider', provider)
  }
  // 来源是多选：同一参数重复出现，服务端按 OR 展开（协议里的 `sources?: string[]`）。
  // ⚠️ 与服务端的匹配口径一致（**精确**），所以这里也**不做任何大小写 / 前缀处理**：
  //   页面把选中的原值原样发出去。
  for (const source of new Set(filter.sources ?? [])) {
    if (source) params.append('source', source)
  }
  for (const key of new Set(filter.users ?? [])) {
    if (key === 'unknown') params.set('unattributed', 'true')
    else params.append(key.startsWith('legacy:') ? 'legacy_user' : 'member_id', key)
  }
  // 分组是多选：同一参数重复出现，服务端按 OR 展开（协议里的 `group_id?: string[]`）。
  for (const groupId of new Set(filter.groups ?? [])) params.append('group_id', groupId)
  return params.toString()
}

/**
 * 分组候选项（`GET /api/v1/stats/groups`）。
 *
 * ★ 刻意走**看板接口**而不是管理接口 `/api/v1/admin/groups`：筛选栏与分组排行
 *   只需要知道「有哪些分组」，而能看数据的人不一定有 `groups:read`。
 * ⚠️ 它不接受筛选参数：候选必须始终是**完整的分组集合**，否则选中一个分组后
 *   下拉会塌缩成一项（自锁定），使用者再也加不回别的分组。
 */
export function fetchGroupOptions(): Promise<ApiResult<StatsGroupsResponse>> {
  return request<StatsGroupsResponse>('/api/v1/stats/groups')
}

/**
 * 人员候选项（`GET /api/v1/stats/members`）。
 *
 * ★ 同样走**看板接口**而不是管理接口 `/api/v1/admin/members`：那是 `members:read`，
 *   而看板使用者不一定有读人员目录的权限。
 * ★ 它带回每个人的**当前分组 ID**，页面据此把人员下拉与分组下拉联动起来
 *   （未选分组 = 全部人员；选中分组 = 只列该分组成员）。
 * ⚠️ 与分组候选同理，**不带任何筛选参数**：候选必须是完整名册。
 *   从已筛选结果里取候选，选中一项之后下拉会塌缩（自锁定）。
 */
export function fetchMemberOptions(): Promise<ApiResult<StatsMembersResponse>> {
  return request<StatsMembersResponse>('/api/v1/stats/members')
}

/**
 * 供应商候选项（`GET /api/v1/stats/providers`）。
 *
 * ★ 同样走**看板接口**（`stats:read`）而不是供应商归一化的管理接口
 *   `/api/v1/admin/provider-aliases`（那是 `providers:read`）：筛选栏只需要
 *   知道「库里出现过哪些供应商名」，能看数据的人不一定能读那份配置。
 * ★ 名字已经是**归一化后**的展示名 —— 它就是筛选可以用的名字（同一份映射）。
 * ⚠️ 与分组 / 人员候选同理，**不带任何筛选参数**：候选必须始终是完整集合，
 *   否则选中一个供应商之后下拉会塌缩成一项（自锁定）。
 */
export function fetchProviderOptions(): Promise<ApiResult<StatsProvidersResponse>> {
  return request<StatsProvidersResponse>('/api/v1/stats/providers')
}

/**
 * 来源候选项（`GET /api/v1/stats/sources`）。
 *
 * ★ 与供应商候选同类（候选必须完整、不带筛选、只回名字），差别只有一条：
 *   来源是**受控枚举**，服务端返回的是「本进程注册的全部来源 ∪ 库里出现过的值」，
 *   所以下拉里会出现本机还没跑过的来源（选中即得 0 行 —— 那是对的答案，
 *   而不是「下拉里没有这一项」）。
 * ⚠️ 它**不是** `allow-create` 的自由输入：未知来源在服务端会被 400 拒掉
 *   （见 `stats-route.ts` 的 `parseWindow`），所以页面不该让人打出任意值。
 */
export function fetchSourceOptions(): Promise<ApiResult<StatsSourcesResponse>> {
  return request<StatsSourcesResponse>('/api/v1/stats/sources')
}

/** 顶部指标卡片。 */
export function fetchOverview(
  filter: PortalFilter,
): Promise<ApiResult<OverviewResponse>> {
  return request<OverviewResponse>(`/api/v1/stats/overview?${toQuery(filter)}`)
}

/**
 * 趋势序列。
 *
 * @param stack 可选的分层维度（`user` / `model`）—— 带上它服务端会多算一趟
 *   「每个桶 × 每个分层」的交叉值（含逐层金额），页面据此画堆叠柱 / 多条折线。
 *   `undefined` = 不展开，载荷里不会有 `stack` 字段（老客户端的行为不变）。
 */
export function fetchSeries(
  filter: PortalFilter,
  bucket: 'day' | 'hour',
  stack?: 'user' | 'model',
): Promise<ApiResult<SeriesResponse>> {
  const params = new URLSearchParams(toQuery(filter))
  params.set('bucket', bucket)
  if (stack) params.set('stack', stack)
  return request<SeriesResponse>(`/api/v1/stats/series?${params.toString()}`)
}

/** 分组排行（`by=user` 即人员排行）。 */
export function fetchBreakdown(
  filter: PortalFilter,
  by: GroupBy,
): Promise<ApiResult<BreakdownResponse>> {
  return request<BreakdownResponse>(
    `/api/v1/stats/breakdown?${toQuery(filter)}&by=${by}`,
  )
}

/** 明细（分页）。 */
export function fetchRecords(
  filter: PortalFilter,
  page: { limit: number; offset: number },
): Promise<ApiResult<RecordsResponse>> {
  const params = new URLSearchParams(toQuery(filter))
  params.set('limit', String(page.limit))
  params.set('offset', String(page.offset))
  return request<RecordsResponse>(`/api/v1/stats/records?${params.toString()}`)
}

/** 采集诊断（覆盖率 / 未归属 / 数据边界）。 */
export function fetchDiagnostics(
  filter: PortalFilter,
): Promise<ApiResult<DiagnosticsResponse>> {
  return request<DiagnosticsResponse>(
    `/api/v1/stats/diagnostics?${toQuery(filter)}`,
  )
}
