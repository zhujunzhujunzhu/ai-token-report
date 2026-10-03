/**
 * 协议契约 —— 前后端唯一的字段真源。
 *
 * ## 为什么必须有这个文件
 *
 * 重构前，CLI 产出的字段（`provider` / `cache_read_tokens`）与前端类型
 * （`apiKey` / `cost` / `requests`）**完全对不上**：
 *
 * | 前端旧字段 | 现在 | 冲突 |
 * |---|---|---|
 * | `apiKey` | `provider` + `model` | 概念不同 |
 * | `cost`（CNY） | 无 | 前端要金额，后端只有 token 数 |
 * | `requests` | `calls` | 同义不同名 |
 * | （无） | `cacheReadTokens` | **漏掉 94.3% 的用量** |
 *
 * 解决办法：两端都从这里 import 类型。字段对不上时 **TypeScript 直接编译不过**，
 * 而不是等到运行时看到空图表才发现。
 *
 * ## 命名约定（不要随意改）
 *
 * - **数据库列 / HTTP 线上字段**：`snake_case`（`cache_read_tokens`）
 * - **TypeScript 内存类型**：`camelCase`（`cacheReadTokens`）
 *
 * 转换只发生在边界（`db/ingest.ts` 与 `web/src/api/`），内核一律用 camelCase。
 */

/** 协议版本。字段不兼容变更时必须 +1，让老客户端能被识别。 */
export const SCHEMA_VERSION = 1 as const

// ─────────────────────────────────────────────────────────────
// 费用（v7 模型单价）
// ─────────────────────────────────────────────────────────────

/**
 * 一档用量的费用（挂在概览 / 排行行 / 趋势点上）。
 *
 * 🚨 **「字段缺席」与「金额是 0」是两件完全不同的事**：
 *   - 调用方没有 `cost:read` → **整个 `cost` 字段不下发**（不是填 0）；
 *   - 有权限、但这批用量一条价都没配上 → `costs: []` + `unpricedRate: 1`。
 *
 * 把第一种回成 0，会让「你没权限」和「这个月没花钱」长得一模一样；
 * 把第二种回成 0，会让「漏配了价」看起来像「省下了钱」。
 * 两种都是这一期最想避免的误读，所以 `cost` 是可选字段而不是默认 0。
 *
 * ⚠️ `pricing` 必须与金额一起下发：同一批用量在「服务端读库里的价」与
 *   「离线端读快照的价」下会给出**两个不同的金额**，页面必须能说清
 *   这一屏是按哪份单价算的。缺它就**不许渲染金额**。
 */
export interface StatsCostTotals {
  /**
   * 按币种分别累加，**绝不跨币种相加**（汇率是第二个口径的典型来源）。
   * 按 `currency` 升序，保证同一份数据永远给出同一个顺序。
   */
  costs: import('./price.js').CostByCurrency[]
  /** 有单价的 token 数。 */
  pricedTokens: number
  /** 无单价的 token 数。 */
  unpricedTokens: number
  totalTokens: number
  pricedRate: number
  unpricedRate: number
  pricing: import('./price.js').PricingProvenance
}

/**
 * 概览档次的费用：额外给出**未配价的目标清单**。
 *
 * ★ 只给一个 `unpricedRate` 是不够的：使用者知道有 12% 没算钱，
 *   却不知道该去补哪个价。清单是「未计价」唯一可行动的形态。
 */
export interface StatsCost extends StatsCostTotals {
  /** `provider/model` 形式，已排序、已截断。 */
  unpricedTargets: string[]
}

/** 明细行的金额；`currency` 为 `null` = 这一条**没配上价**（不是 0 元）。 */
export interface StatsRecordCost {
  currency: string | null
  amountMicro: number
}

/**
 * `GET /api/v1/stats/pricing` —— 单价只读快照。
 *
 * ★ 与 `/api/v1/admin/pricing` **刻意分开**：那条是**配置**（读也要求
 *   `pricing:manage`），这条是**看数据时的解释材料**（`cost:read`）。
 *   离线端（CLI / 本地页 / 插件）靠它拿到与服务端同一份单价，
 *   否则四个形态会各算一个金额。
 */
export interface StatsPricingResponse {
  prices: import('./portal-identity.js').PortalModelPrice[]
  pricing: import('./price.js').PricingProvenance
}

// ─────────────────────────────────────────────────────────────
// 上报方向：CLI → Server（POST /api/v1/token-usage）
// ─────────────────────────────────────────────────────────────

/**
 * 一条计费事件（线上格式，下划线字段）。
 *
 * ⚠️ **这个结构已由 CLI 侧固化**（见 `packages/cli/src/deliver.ts` 的 `toWireRecord`），
 * 服务端必须原样遵守，改动会导致老客户端静默丢数据。
 */
export interface WireTokenRecord {
  /** 幂等键：`${sessionId}:${seq}`。服务端以此为 PRIMARY KEY。 */
  event_id: string
  session_id: string
  /** 会话内单调序号，与 session_id 共同构成幂等键。 */
  seq: number
  /** epoch 毫秒 */
  ts: number
  provider: string
  model: string
  /** 未命中缓存的输入 */
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  /** 校验用，应等于四项之和 */
  total_tokens: number
  /** 工作目录，用于项目归因 */
  cwd: string | null
  turn: number | null
  step: number | null
  /**
   * 这条用量是**哪个客户端**写的（`dsh` / `codex` / `claude-code` / `trae` /
   * `trae-cn` / `workbuddy`）。
   *
   * ★ **可选**：v9 之前发布的客户端一个字节都不发这个字段，服务端把它们
   *   按库内默认值 `dsh` 落库 —— 那不是猜测：v9 之前只有 DSH 上报过
   *   （`report` 只扫 DSH 的会话根）。
   * ⚠️ 服务端**不按注册表严格校验**它（只校验形状，见 `schemas.ts`）：
   *   客户端比服务端新时，严格枚举会让整批上报被拒，而 CLI 会把 pending
   *   一直重发 —— 采集在那台机器上永久停住。未知值原样入库，并由
   *   `/api/v1/stats/sources` 一并列出（看板因此看得到也筛得中）。
   */
  source?: string
}

/**
 * 上报方身份。
 *
 * ★ **`userId` 由服务端从 token 解析得出，客户端不可信**。
 *   客户端可以填任何值，服务端一律以 `Authorization` 头里的 token 为准。
 *   这样即使本地配置文件被篡改，也无法冒用他人身份。
 */
export interface WireClientIdentity {
  /** 客户端自称的标识。**服务端应忽略此字段**，仅用于排查。 */
  userId: string
  userName?: string
  /**
   * 客户端在身份文件里填的分组名快照。
   *
   * ★ 只是**快照文本**，不参与归属：真正的归属由服务端按 token 查出
   *   `member_id`，再经 `member_group_members` 关联出分组。
   *   快照列让「这个人当时自己填的是哪个分组」在改名/改组之后仍可追溯。
   */
  group?: string
  /**
   * ⚠️ **已废弃，仅为兼容旧插件 / 旧 CLI 保留读取**。
   *
   *   旧客户端发的是 `dept`；服务端把它当作 `group` 的同义字段写入
   *   `usage_event.group_name`。新代码一律用 `group`。
   */
  dept?: string
}

/** 上报请求体。 */
export interface IngestPayload {
  schemaVersion: number
  client: WireClientIdentity
  /** ISO 8601 */
  generatedAt: string
  records: WireTokenRecord[]
}

/**
 * 上报响应。
 *
 * ★ 三个计数必须是非负整数，且合计等于本批记录数。
 * 客户端只有在收到完整、匹配的确认后才能清除已投递记录；
 * 空响应、HTML 或缺失计数都不能当作「全部接受」。
 * 响应未包含逐条拒收标识，存在 rejected 时不能按数组位置猜测哪些记录成功。
 */
export interface IngestResponse {
  /** 新插入的行数 */
  accepted: number
  /** 因 event_id 冲突被跳过的行数 */
  duplicates: number
  /** 因数据非法被拒的行数 */
  rejected: number
}

// ─────────────────────────────────────────────────────────────
// 查询方向：Web → Server（GET /api/v1/stats/*）
// ─────────────────────────────────────────────────────────────

/** 分组维度。与 CLI 的 `--by` 选项保持一致。 */
export type GroupBy = 'provider' | 'model' | 'provider-model' | 'source' | 'user' | 'group' | 'project' | 'day' | 'hour'

/** 时间分桶粒度。 */
export type Bucket = 'day' | 'hour'

/**
 * 未归属（没有署名）的归属键。
 *
 * ★ 这个常量是**唯一的**「未归属」表述：库里未归属的行 `user_id IS NULL`，
 *   而所有对外展示（分组键、筛选值）一律用这个字符串。
 *   `server/src/stats-route.ts` 与 `core/db/query.ts` 都从它取值 ——
 *   两边各写一个字面量的话，「筛选 unknown 得到 0 行」这种分叉迟早出现。
 */
export const UNATTRIBUTED_USER = 'unknown' as const

/** 查询的公共筛选条件。所有 stats 接口共用。 */
export interface StatsQuery {
  identity_view?: 'legacy' | 'member'
  member_id?: string[]
  legacy_user?: string[]
  unattributed?: boolean
  /**
   * 按分组过滤（多选，**精确匹配**稳定分组 ID）。
   *
   * ⚠️ 多对多语义下的取舍：一个人可同属多个分组，所以**多选是 OR**——
   *   命中任一所选分组即计入。因此「按两个分组筛出来的合计」会大于
   *   全量合计，这不是 bug：同一条事件本来就要计入它的人员所属的每个分组。
   */
  group_id?: string[]
  /** epoch 毫秒；缺省表示不限 */
  from?: number
  to?: number
  /**
   * 具名周期（`today` / `week` / `last7d` / …），与 CLI 的 `--period` 完全同义。
   *
   * ★ **由服务端解析**（`core/range.ts` 的 `resolveRange`），前端不做任何日期换算：
   *   让浏览器自己算「本月从哪一天开始」等于把时区口径复制到第二个地方，
   *   跨天、跨时区时页面与命令行必然对不上。
   *   显式的 `from` / `to` 优先于它。
   */
  period?: string
  /** 子串匹配，与 CLI 的 `--provider` 行为一致 */
  provider?: string
  model?: string
  /**
   * 按**来源**筛选（多选，OR），例如只看 Codex 与 Claude Code 的用量。
   *
   * ★ **精确匹配，不是子串** —— 与 `provider` 刻意相反：来源是受控枚举
   *   （`dsh` / `codex` / `claude-code` / `trae` / `trae-cn` / `workbuddy`），
   *   子串匹配会让 `code` 命中 `codex`、`trae` 命中 `trae-cn`，
   *   而那是两个**独立安装、独立账号**的来源（见 `sources/trae.ts` 文件头）。
   *   `core/db/query.ts` 的 `buildWhere()` 因此也是 `source = ?` 而不是 LIKE。
   */
  sources?: string[]
  /**
   * 按署名过滤，用于「只看某人」。**精确匹配**（不是子串）：
   * 子串匹配会把「张三」和「张三丰」混成一个。
   *
   * 特殊值 {@link UNATTRIBUTED_USER} 表示只看未归属的数据。
   */
  userId?: string
}

/** 顶部指标卡片。 */
export interface OverviewResponse {
  /**
   * 当前筛选范围的实际起止（服务端可能因无数据而收缩）。
   * `label` 是服务端解析出的**人话口径**（如「最近 7 天（自然日）」），
   * 页面直接展示，不在前端重算。
   */
  range: { from: number | null; to: number | null; label: string }
  /** 计费总量 */
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 调用次数（= usage 事件条数） */
  calls: number
  /** 涉及的会话数 */
  sessions: number
  /** 缓存命中率 0~1 */
  cacheHitRate: number
  /** 平均每次调用 token 数 */
  avgTokensPerCall: number
  /**
   * 未归属占比 0~1（`userId === 'unknown'` 的调用数 / 总调用数）。
   * 用于监控采集覆盖率，防止「数据悄悄少了」这种最难排查的故障。
   *
   * ★ 公式在 `metrics.ts` 的 `unattributedRate()`，服务端调用它而不是就地做除法。
   */
  unattributedRate: number
  /**
   * 费用汇总。**只有具备 `cost:read` 的调用方才会拿到这个字段** ——
   * 没权限时它整个缺席（而不是 0），见 {@link StatsCostTotals} 的说明。
   */
  cost?: StatsCost
}

/** 趋势图的一个点。 */
export interface SeriesPoint {
  /** `2026-09-21` 或 `2026-09-21T14` */
  bucket: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  calls: number
  cacheHitRate: number
  /** 该点的费用（同样只在有 `cost:read` 时下发）。 */
  cost?: StatsCostTotals
}

/**
 * 趋势图的**分层维度**（堆叠柱 / 多条折线按谁展开）。
 *
 * ★ 只有这两个：`user` 与 `model` 是使用者真正会问的「这段时间是谁 / 是哪个模型
 *   在用」。供应商、项目、分组刻意不在协议里 —— 供应商与项目由分布表回答，
 *   而分组是**多对多**展开（一条事件计入所属的每个分组），画成堆叠柱会让
 *   「各层之和 > 总量」看起来像画错了。
 */
export type SeriesStackBy = 'user' | 'model'

/**
 * 被合并成「其余 N 个」的那一层的分组键。
 *
 * ⚠️ 它**不是一个真实的用户 / 模型**：真实键是人员 UUID、`legacy:…`、`unknown`
 *   或模型名，都不可能等于这个带双下划线的哨兵。页面要认出它并把说明写清楚
 *   （「其余 12 个」），否则使用者会把这一层当成某个人。
 */
export const SERIES_STACK_MERGED_KEY = '__other__' as const

/**
 * 堆叠趋势里的一层（一个用户 / 一个模型）。
 *
 * ★ `values` 与 `calls` 都**与 `points` 按下标一一对齐**（服务端补零之后的桶序），
 *   页面只按下标取值 —— 让前端自己去对桶键等于把时间分桶口径复制到第二个地方。
 * ★ 各层之和**恒等于**同一下标的 `points[].totalTokens` / `points[].calls`：
 *   被截断的那些层进了 `merged` 那一项，所以堆叠柱的总高永远等于趋势总量。
 * ★ `cost` 是**单币种**的逐桶整数微元（与 `values` 同样按下标对齐）。整块缺席 =
 *   这次没算金额（没有 `cost:read`）**或**区间内不止一种币种 ——
 *   两者都绝不允许页面自己挑一个币种去画（多币种绝不换算、绝不相加）。
 *   币种本身在 `points[].cost.costs[].currency` 上，页面不必再看第二处定义。
 */
export interface SeriesStackItem {
  /** 人员 UUID / `legacy:…` / `unknown` / 模型名 / {@link SERIES_STACK_MERGED_KEY}。 */
  key: string
  /** 已经拼好的展示名（与人员排行的行名同源）。 */
  label: string
  /** 只有 `by: 'user'` 且有稳定人员 ID 时才有：同名消歧要用。 */
  member_id?: string | null
  /** 该人员**当前**所属的分组名；`by: 'model'` 与未分组人员都没有。 */
  group_names?: string[]
  attribution_status?: import('./portal-identity.js').PortalAttributionStatus
  /** `true` = 「其余 N 个」的合并项，不是单个人 / 单个模型。 */
  merged?: boolean
  /** 与 `points` 对齐的**计费总量**。 */
  values: number[]
  /** 与 `points` 对齐的**调用次数**。 */
  calls: number[]
  /** 与 `points` 对齐的**金额（整数微元，单币种）**；缺席见上面的说明。 */
  cost?: number[]
}

export interface SeriesStack {
  by: SeriesStackBy
  /** 按窗口内总量降序；合并项（若有）恒在最后一项。 */
  items: SeriesStackItem[]
  /** 被合并进「其余」的层数；`0` = 没有截断，`items` 就是全部。 */
  mergedCount: number
}

export interface SeriesResponse {
  bucket: Bucket
  points: SeriesPoint[]
  /**
   * 分层明细，**只在请求带了 `stack=user|model` 时才下发**。
   *
   * ⚠️ 缺字段 = 「没要过分层」，不是「这段时间没人」：页面据此决定画单序列
   *   还是堆叠图。回一个空 `items` 会让「旧服务端」与「真的没有用量」长得一样。
   */
  stack?: SeriesStack
}

/** 分组排行的一行。 */
export interface BreakdownRow {
  key: string
  label?: string
  member_id?: string | null
  /** 该人员当前所属的全部分组名；分组维度的行本身没有它。 */
  group_names?: string[]
  attribution_status?: import('./portal-identity.js').PortalAttributionStatus
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  calls: number
  cacheHitRate: number
  /** 该行（这个人员 / 供应商 / 分组…）的费用。 */
  cost?: StatsCostTotals
}

export interface BreakdownResponse {
  by: GroupBy
  rows: BreakdownRow[]
}

/** 明细表一行（供分页表格）。 */
export interface RecordRow {
  eventId: string
  sessionId: string
  seq: number
  ts: number
  userId: string
  member_id?: string | null
  user_name_snapshot?: string | null
  /** 该人员当前所属的分组 ID；不是上报时的值（那个在 `group_name_snapshot`）。 */
  group_ids?: string[]
  /** 上报当时客户端自己填的分组文本快照。 */
  group_name_snapshot?: string | null
  attribution_status?: import('./portal-identity.js').PortalAttributionStatus
  /**
   * 供应商的**展示名**：已经按 `provider_alias` 规则归一化过。
   * 没配规则时等于 `providerRaw`。
   */
  provider: string
  /**
   * 上报当时的供应商**原值**。
   *
   * ★ 明细是唯一能核对「规则配得对不对」的地方：只显示展示名的话，
   *   一条把 `dashscope` 错配成 `bailian-tpp` 的规则会表现得完全正常 ——
   *   总量对、名字错，没有任何地方能看出来。
   * 两者相同时前端不必展示它（页面本来就该干净）。
   */
  providerRaw?: string
  model: string
  /**
   * ★ v9：这条用量是**哪个客户端**写的（`dsh` / `codex` / `claude-code` /
   * `trae` / `trae-cn` / `workbuddy`）。
   *
   * ⚠️ 它是上报当时的**原值**，查询期不做任何归一化（与 `provider` 的展示名刻意相反）：
   *   来源是受控枚举，`trae` 与 `trae-cn` 是两个独立安装、独立账号的来源，
   *   归一化会把它们混成一个 —— 那正是本仓在别处花大力气避免的错。
   * ⚠️ 明细是唯一能逐条核对来源的地方：只看看板的来源汇总时，
   *   「筛了 Codex 但这一行其实是 DSH」这种问题看不出来。
   */
  source: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cwd: string | null
  /**
   * 这一条事件的费用。
   *
   * ★ 明细是**唯一**能逐条核对金额的地方：同一页里两行同一个模型却给出不同
   *   单价，正是「换价那一刻」的证据。缺这个字段（无 `cost:read`）时页面
   *   不显示金额列，而不是显示一列 0。
   */
  cost?: StatsRecordCost
}

export interface RecordsResponse {
  total: number
  limit: number
  offset: number
  rows: RecordRow[]
}

/**
 * 筛选栏与分组排行要用的分组候选项（`GET /api/v1/stats/groups`）。
 *
 * ★ 刻意由**看板接口**提供而不是让页面去读管理接口 `/api/v1/admin/groups`：
 *   能看数据的人不一定有 `groups:read`（那是管理目录权限），
 *   而「按什么分组筛数据」是看板自身的能力。少一个权限就少一处 403。
 * ⚠️ 候选**只列存在的分组**，不掺入数据里出现过的快照文本 ——
 *   快照文本是可以随便填的，拿它当筛选项等于让页面按错别字筛选。
 */
export interface StatsGroupOption {
  group_id: string
  name: string
  status: 'active' | 'disabled'
  /** 当前关联到该分组的人员数（不是事件数）。 */
  member_count: number
}

export interface StatsGroupsResponse {
  groups: StatsGroupOption[]
}

/**
 * 筛选栏与人员排行用的人员候选项（`GET /api/v1/stats/members`）。
 *
 * ★ 刻意由**看板接口**提供（`stats:read`）而不是让页面去读管理接口
 *   `/api/v1/admin/members`（那是 `members:read`）：能看数据的人不一定能读
 *   人员目录，而「按谁筛选」是看板自身的能力。
 *
 * ★ 它是下拉里**唯一**能列出「当前时间窗内没有用量的人」的来源。
 *   从用量行里取候选时，刚入职、休假、只在别的窗口用过的人都不会出现，
 *   选中一个分组之后整个下拉会直接空掉 —— 那看起来像数据丢了，
 *   而不像「这段时间没人用」。
 *
 * ⚠️ 只回筛选要用的三样：稳定 ID、显示名、**当前**所属分组 ID。
 *   角色、权限、登录账号属于管理面，不因为看得见用量就一起下发。
 * ⚠️ 已停用人员**照样列出**并标注（与分组候选同款）：停用只影响
 *   「以后还能不能选他」，历史用量仍然在他名下。
 */
export interface StatsMemberOption {
  member_id: string
  name: string
  /** 与人员管理页同一种状态枚举（含 `archived`）—— 两处不能各写一份。 */
  status: import('./portal-identity.js').PortalMemberStatus
  /** 当前所属分组 ID（多对多；未分组 = 空数组）。 */
  group_ids: string[]
}

export interface StatsMembersResponse {
  members: StatsMemberOption[]
}

/**
 * 筛选栏要用的供应商候选项（`GET /api/v1/stats/providers`）。
 *
 * ★ 同样由**看板接口**提供（`stats:read`），不是供应商归一化的管理接口
 *   `/api/v1/admin/provider-aliases`（那是 `providers:read`）：
 *   「按哪个供应商筛数据」是看板自身的能力，一个筛选下拉不该顺带具备
 *   配置面的读权限。
 *
 * ★ 名字是**归一化后**的展示名，与筛选的匹配口径逐字同一份
 *   （`core/db/query.ts` 的 `providerFilterExpression()`）：使用者看到
 *   `bailian-tpp`，筛 `bailian-tpp` 就必须把 `dashscope` 那些原值一起筛出来。
 *   回原始名会造出「按页面上看到的名字筛，一行都筛不出来」这种查不出原因的坑。
 *
 * ⚠️ 只回名字，**不含任何用量数字**（没有条数、没有 token），因此它是一份
 *   **目录**：与分组 / 人员候选一样**不跟着数据范围收窄**（`applyDataScope()`
 *   只管用量查询）。
 */
export interface StatsProvidersResponse {
  /** 去重、升序的展示名（多条规则指向同一个名字时只出现一次）。 */
  providers: string[]
}

/**
 * 筛选栏要用的**来源**候选项（`GET /api/v1/stats/sources`）。
 *
 * ★ 与 {@link StatsProvidersResponse} 的唯一结构差别是**值域受控**：
 *   来源是受控枚举（`dsh` / `codex` / `claude-code` / `trae` / `trae-cn` /
 *   `workbuddy`，见 `core/src/sources/registry.ts`），所以候选项 =
 *   本进程注册的全部来源 **∪** 库里实际出现过的值。前者的作用是
 *   「本机还没跑过 Codex 时也能筛它、得到如实的 0 行」，后者兜住
 *   「更新版客户端上报了一个本进程还不认识的来源」—— 只在库里取候选的话，
 *   那种行在页面上看得到却筛不出来。
 *
 * ⚠️ 与供应商候选同样：只回名字、不含任何用量数字，也不跟着数据范围收窄。
 * ⚠️ 顺序固定（`dsh` 在最前，其余字典序）：下拉项序不该随库里的数据变化。
 */
export interface StatsSourcesResponse {
  sources: string[]
}

/**
 * 「一天中的第几小时」的消耗分布（**工作时段分布**）。
 *
 * ★ 与 `SeriesResponse` 的区别是**分桶键不同**，不是粒度不同：
 *   `series?bucket=hour` 的点是「哪一天的哪一小时」（`2026-10-01T14`），
 *   而这里的 key 是**一天中的第几小时**（`14`）—— 它把所有日期的同一时刻
 *   **折叠**在一起，所以只有 24 个点（有数据的小时才出现）。
 *
 * ⚠️ 因此它**不能**由 `series` 派生，也不能由「按天汇总」派生：
 *   按天汇总会把一天里的 24 小时合并成一行，时段信号就永久丢失了。
 *
 * ⚠️ **`sessions` 不在载荷里**：去重会话数不可加（跨天会话会被算两次），
 *   它只能走原始表，而本接口刻意走汇总表。要会话数请用 `overview`。
 */
export interface HourOfDayResponse {
  /** 统计口径：是否只算工作日 / 只算周末。 */
  day_kind: 'all' | 'workday' | 'weekend'
  /** 升序；只含**有数据**的小时（不补零 —— 补零会把「没人用」和「缺数据」混起来）。 */
  points: {
    /** 0~23，**本地时区**。 */
    hour: number
    calls: number
    totalTokens: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    cacheHitRate: number
  }[]
  range: { from: number | null; to: number | null; label: string }
}

/** 当前实例的入口队列观测；完成计数包含业务拒绝，不代表成功落库条数。 */
export interface IngestQueueStatusResponse {
  scope: 'process'
  accepting: boolean
  active_requests: number
  waiting_requests: number
  max_requests: number
  max_wait_ms: number
  oldest_wait_ms: number
  completed_requests: number
  rejected_requests: number
  last_wait_ms: number
  last_processing_ms: number
  last_completed_at: number | null
}

/**
 * 数据质量诊断。
 *
 * 用于回答「数据是不是少了」这类运维问题 —— 没有这组指标，
 * 采集链路的静默失败几乎无法发现。
 */
export interface DiagnosticsResponse {
  /** 落库总事件数 */
  totalEvents: number
  /** 未归属事件数与占比 */
  unattributedEvents: number
  unattributedRate: number
  /** 恒等式校验失败的行数（应恒为 0） */
  identityViolations: number
  /** 非空归属分组数；成员视图分别统计稳定人员与待关联历史身份，不等于机器数或实际人数。 */
  distinctUsers: number
  /** 最早 / 最晚事件时间 */
  earliestTs: number | null
  latestTs: number | null
  /** 最近一次上报时间（用于判断某台机器是否掉线） */
  lastIngestAt: number | null
}

// ─────────────────────────────────────────────────────────────
// 本地直查：本地页 → 本地服务（GET /api/local/stats/*）
// ─────────────────────────────────────────────────────────────
//
// ★ 与上面 `/api/v1/stats/*` 的**部门看板**契约刻意分开，不要合并。
//   两者的数据源根本不同：
//
//   | | /api/v1/stats/* | /api/local/stats/* |
//   |---|---|---|
//   | 数据源 | SQLite（全员已上报数据） | **本地 SQLite 库**（本机日志派生） |
//   | 范围 | 全员 | 只有我自己 |
//   | `userId` | 有（人员排行） | **不存在** |
//   | `unattributedRate` | 有（覆盖率监控） | **不存在**（本机不存在归属问题） |
//
//   ⚠️ 两个库是**不同文件**：部门端用 `dbPath`（含全员上报数据），
//      本地端用 `~/.ai-token-report/usage.sqlite`（只含本机数据）。
//      本地端因此仍然「断网可用、服务端挂掉不影响看自己的数据」。
//
//   早期图省事让本地页复用部门契约，结果是把「本机根本没有的概念」
//   硬填成 0 —— 页面上那个「未归属占比 0%」纯属虚构，比没有更糟。

/** 本地页可用的分组维度。**不含 `user`** —— 本机数据只有我一个人。 */
export type LocalGroupBy = 'provider' | 'model' | 'provider-model' | 'project' | 'day' | 'hour'

/** 本地页的时间窗（复用 `core/range.ts` 的具名周期）。 */
export interface LocalStatsQuery {
  /**
   * 具名周期，与 CLI `--period` 完全同义：
   * `today` / `yesterday` / `week` / `lastweek` / `month` / `lastmonth` /
   * `year` / `last7d` / `last14d` / `last30d` / `last90d`，也接受中文别名。
   *
   * 缺省 = 全部时间。
   */
  period?: string
  /** 子串匹配，与 CLI 的 `--provider` 行为一致。 */
  provider?: string
  /** 子串匹配，与 CLI 的 `--model` 行为一致。 */
  model?: string
}

/**
 * ★ 统计的**数据来源** —— 回答「这个数是从哪几处日志算出来的」。
 *
 * 同一台机器上并存多套 DSH 时（命令行版 / Desktop / 第三方客户端），会话日志根是
 * **一组**，统计是它们的**并集**（互为镜像的会话按 `event_id` 去重，只算一次）。
 * 没有这组字段就分不清两件**看起来完全一样**的事：
 *
 * - 「并按集去重」—— 加了一个 home，数字只涨了一点，**这是对的**；
 * - 「那个根根本没读到」—— 数字同样没怎么涨，**这是 bug**。
 *
 * 所以 `missingRoots` 必须逐项报出、绝不静默。
 */
export interface LocalStatsSources {
  /** 本次统计读的**会话日志根**（绝对路径）。多个 = 多来源 / 多套 DSH 的并集去重。 */
  sessionsRoots: string[]
  /** 配了但**不存在**的根：逐项列出，不静默跳过。 */
  missingRoots: string[]
  /** token-report 自己的**数据目录**（身份 / 本地库 / outbox / 补报水位）；与会话日志根无关。 */
  dataDir: string | null
  /**
   * ★ 按**来源**分组的根（多客户端：`dsh` / `codex` / …）。
   *
   * 为什么不能只给 `sessionsRoots`：多来源之下「读了哪几处」与「这些数字是谁的」
   * 是两个问题，而扁平的那一组根答不出第二个 —— Codex 的根与 DSH 的根在
   * 同一个数组里，页面上就只能说一句「N 个会话日志根」。
   *
   * ⚠️ **可选**：老服务端不返回它。消费方缺字段时必须退化成旧文案，
   *   而不是显示一个空的来源列表（那会把「老服务端」说成「没有任何来源」）。
   */
  bySource?: Array<{
    /** 来源 id（受控枚举：`dsh` / `codex` / `claude-code` / `trae` / `trae-cn` / `workbuddy` / …）。 */
    source: string
    /** 该来源**存在**的根。 */
    roots: string[]
    /** 该来源配了但不存在的根。 */
    missingRoots: string[]
  }>
}

/**
 * 本地指标卡片（`GET /api/local/stats/overview`）。
 *
 * ★ 四项 token **分列**，与铁律 3 一致：采集端一旦合并，后续拆分无法还原。
 *   页面要展示「计费总量」时由前端相加或直接用 `totalTokens`，
 *   但**线上字段永远保持四个独立数字**。
 */
export interface LocalOverviewResponse {
  /** 实际统计窗口（服务端解析后的绝对时间，便于页面显示口径）。 */
  range: { from: number | null; to: number | null; label: string }
  /** ★ 数据来源：读了哪几个会话日志根（多套 DSH 并存时是并集）。 */
  sources: LocalStatsSources
  /** 计费总量 = input + output + cacheRead + cacheWrite */
  totalTokens: number
  /** ★ 未命中缓存的输入，**不是**总输入。 */
  inputTokens: number
  outputTokens: number
  /** ★ 实测占总用量 94.3% 的那一项。前端旧模型漏掉它 = 漏掉 94% 的用量。 */
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 推理 token。多数 provider 不下发，恒为 0 属正常。 */
  reasoningTokens: number
  /** 调用次数（= `assistant/message` 且带 usage 的事件数）。 */
  calls: number
  /** 涉及的会话数。 */
  sessions: number
  /** 缓存命中率 0~1 = cacheRead / (cacheRead + input)。 */
  cacheHitRate: number
  /** 缓存杠杆倍数 = cacheRead / input。 */
  cacheLeverage: number
  /** 平均每次调用的计费 token。 */
  avgTokensPerCall: number
  /** 扫描完成时刻，用于页面显示「数据多新」。 */
  scannedAt: number
  /** 本次是否命中进程内缓存（未重扫日志）。 */
  cached: boolean
  /**
   * 费用（估算）。
   *
   * ★ 本地页**没有权限模型**（它只读本机日志、不出网），所以这个字段总是下发 ——
   *   与部门看板不同，那里没有 `cost:read` 时**整个字段缺席**。
   *   但「按哪份单价算的」这条信息在这里**更重要**，因为离线端读的是
   *   `pricing.json` 快照、看板读的是库里的 `model_price`：
   *   两者给出的金额会不一样，而都「看起来正常」（见 `CostTotals.pricing`）。
   *
   * ⚠️ 仍然写成可选：页面与它内嵌的服务端是两个产物，版本可能不同步。
   *   页面按「字段在不在」决定出不出现，绝不当成 0。
   */
  cost?: StatsCostTotals
}

/** 本地趋势的一个点（`GET /api/local/stats/series`）。 */
export interface LocalSeriesPoint {
  /** `2026-09-21` 或 `2026-09-21T14` */
  bucket: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  calls: number
  cacheHitRate: number
  /**
   * 该桶的费用（估算）。
   *
   * ★ 按**事件发生时刻**逐条取价后汇总，所以换价那一刻两侧的桶各用各的价 ——
   *   不是「桶内 token 总量 × 一个价」（那会把换价前后的用量全按其中一个价算）。
   *   多币种各自累加、绝不相加（`costs` 数组按币种分开）。
   */
  cost?: StatsCostTotals
}

export interface LocalSeriesResponse {
  bucket: Bucket
  points: LocalSeriesPoint[]
  /** 数据新鲜度：扫描时刻与本次是否命中缓存。 */
  scannedAt: number
  cached: boolean
}

/** 本地分组排行的一行。 */
export interface LocalBreakdownRow {
  key: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  calls: number
  cacheHitRate: number
  /**
   * 该行（维度值）的费用（估算）。
   *
   * ★ 分组键与 `key` **逐字相同**（服务端复用 `core/aggregate.ts` 的 `groupKey()`），
   *   所以页面上这一行的金额与排行里那一行必然对得上 —— 自己拼一遍键的话，
   *   「项目」与「按天」这两维会悄悄错开，而两张表看起来都正常。
   */
  cost?: StatsCostTotals
}

export interface LocalBreakdownResponse {
  by: LocalGroupBy
  rows: LocalBreakdownRow[]
  /** 数据新鲜度：扫描时刻与本次是否命中缓存。 */
  scannedAt: number
  cached: boolean
}

/**
 * 本地扫描诊断（`GET /api/local/stats/diagnostics`）。
 *
 * 回答「页面上的数是不是少了」—— 恒等式校验失败、缺少 usage 的 assistant 消息、
 * 解压失败帧数都在这里。没有这组数字，采集链路的静默失败几乎无法发现。
 *
 * ⚠️ `core` 的 `ScanDiagnostics` 里 `eventTypes` / `providersSeen` 是 `Map` / `Set`，
 *   `JSON.stringify` 会把它们变成 `{}` / `[]`。**必须在服务端显式转换为对象/数组**，
 *   否则页面拿到的是空壳，看着像「没有数据」。
 */
export interface LocalDiagnosticsResponse {
  filesScanned: number
  filesFailed: number
  framesOk: number
  framesFailed: number
  totalEvents: number
  usageEvents: number
  /** 缺少 usage 的 `assistant/message` 条数（正常应很少）。 */
  assistantMessagesWithoutUsage: number
  /** ★ 恒等式校验失败数，**正常恒为 0**；非 0 说明解析出错或 provider 口径变了。 */
  totalTokenMismatches: number
  retryStarted: number
  retry: number
  attempts: number
  /** 未识别到 provider 的事件数。 */
  missingProvider: number
  /** 事件类型分布，按出现次数降序。 */
  eventTypes: Record<string, number>
  /** 出现过的 provider，已排序。 */
  providersSeen: string[]
  /** ★ 数据来源：与 `overview` 同一组根，便于诊断页对照「数字来自哪几处」。 */
  sources: LocalStatsSources
  scannedAt: number
  cached: boolean
}

/** `POST /api/local/refresh` —— 强制失效缓存，下次请求重扫。 */
export interface LocalRefreshResponse {
  ok: boolean
  /** 失效前的缓存建立时刻；从未扫描过时为 null。 */
  invalidatedAt: number | null
}

// ─────────────────────────────────────────────────────────────
// 身份署名：本地页引导 ↔ 服务端签发/校验
// ─────────────────────────────────────────────────────────────

/**
 * 本地页的署名状态（`GET /api/local/identity`）。
 *
 * ★ 返回体**不含 token** —— 页面只需要知道「填没填」和「填的什么名字」，
 *   把 token 发回浏览器等于让它暴露在 devtools、缓存与 XSS 面前。
 */
export interface LocalIdentityResponse {
  /** 是否已署名完成。false 时页面应弹出引导。 */
  signed: boolean
  /** 姓名。未署名时为 null。 */
  name: string | null
  group: string | null
  createdAt: number | null
  /** 未署名时给出提示文案，由服务端决定，便于统一措辞。 */
  hint: string | null
}

/**
 * 提交署名（`POST /api/local/identity`）。
 *
 * ★ 服务端必须在此刻**向平台服务端校验 token**，校验通过才落盘。
 *   本地不做形式以外的判断。
 */
export interface LocalIdentitySubmit {
  name: string
  token: string
  group?: string
}

/** 署名提交结果。 */
export interface LocalIdentitySubmitResponse {
  ok: boolean
  /** 失败原因，可直接展示给用户。 */
  reason?: string
  /** 成功后回显的姓名（供页面立即更新，无需再请求一次）。 */
  name?: string
  group?: string
}

/**
 * 服务端校验 token 的结果（内部接口，本地服务 → 部门服务端）。
 *
 * 用于回答「这个 token 是谁的」。若服务端尚未登记任何凭证，
 * 则返回 `registered: false`，本地服务据此给出「请让管理员先发放 token」的提示，
 * 而不是含糊地报「token 无效」。
 */
export interface VerifyTokenResponse {
  ok: boolean
  member_id?: string
  /** 该 token 对应的姓名（由服务端决定，客户端不可覆盖）。 */
  name?: string
  group?: string
  /**
   * ⚠️ **已废弃，仅为兼容旧插件 / 旧 CLI 保留**：与 `group` 同值。
   *   新代码读 `group`。兼容期结束后删掉这个别名。
   */
  dept?: string
  /**
   * 该 token 的角色。服务端**始终**返回它，页面据此决定是否显示管理页。
   *
   * 🚨 消费方（页面/插件）在字段缺失时必须按 {@link ROLE_MEMBER} 处理，
   *   绝不能默认成管理员 —— 那会让一个老服务端或一次字段改名
   *   直接变成「人人可发 token」。
   */
  role?: UserRole
  /** 服务端是否已配置任何凭证。 */
  registered?: boolean
  reason?: string
}

// ─────────────────────────────────────────────────────────────
// 旧文件凭证兼容类型：仅供旧构造器测试和迁移解析使用。
// ─────────────────────────────────────────────────────────────
//
// 生产管理接口的数据库 DTO 位于 portal-identity.ts；不要给新页面使用下面的
// AdminMember/AdminFileStatus。正常服务的人员、权限与凭证唯一真值已经是数据库。

/**
 * 角色。
 *
 * 旧客户端和导入格式的兼容角色。生产授权查数据库当前 permissions，
 * Bearer 再与 Token scopes 取交集；姓名绝不能作为授权依据。
 *
 * ★ 它同时是**数据范围**的判据（`server/src/stats-route.ts` 的
 *   `applyDataScope()`）：只有内置 `admin` 角色能看到全部门的用量，
 *   其余身份一律只看得到自己。这里比对的是**内置角色码**，不是权限码。
 */
export type UserRole = 'admin' | 'member'

/** 管理员：可看全部门看板，并可在管理页发放 / 重置 / 吊销 token。 */
export const ROLE_ADMIN: UserRole = 'admin'
/** 普通成员：**只看得到自己的统计**（数据范围由服务端强制），看不到管理页。 */
export const ROLE_MEMBER: UserRole = 'member'

/** 判断一个任意值是否是合法角色。 */
export function isUserRole(value: unknown): value is UserRole {
  return value === ROLE_ADMIN || value === ROLE_MEMBER
}

/** 凭证来源。`env` 表示由 `ATR_ADMIN_TOKEN` 注入，管理页不能改它。 */
export type CredentialSource = 'file' | 'env'

/** 管理页里的一行人员。 */
export interface AdminMember {
  /** 后台账号；旧凭证未设置时为空。不返回密码或哈希。 */
  username?: string | null
  login_enabled?: boolean
  /**
   * 身份 token。
   *
   * ★ 这里**刻意返回明文**：管理页的用途就是「把 token 发给本人」与
   *   「补发时把原值再发一次」。能打开这个页面的人本来就能读到
   *   `credentials.json`（文件本身就是明文，理由见 credentials.ts）。
   *   而本地页的 `GET /api/local/identity` 依然**绝不回传 token**。
   */
  token: string
  name: string
  group: string | null
  role: UserRole
  /** token 发放时刻（epoch ms）。手工写进文件的凭证没有这个字段 → null。 */
  createdAt: number | null
  source: CredentialSource
}

/** `GET /api/v1/admin/members` —— 人员列表 + 凭证文件状态。 */
export interface AdminMembersResponse {
  members: AdminMember[]
  /** 凭证文件的绝对路径（管理员要知道自己在维护哪个文件）。 */
  credentialsPath: string
  /** 当前是否可写入（解析失败或目录不可写时为 false）。 */
  writable: boolean
  /** 不可写的原因，可直接展示给管理员。 */
  writeBlockedReason: string | null
}

/**
 * 签发一个 token（`POST /api/v1/admin/members`）。
 *
 * 姓名是**归属的唯一键**：同名会让看板把两个人并成一个人，
 * 因此服务端会拒绝重名（见 `member-admin.ts`）。
 */
export interface AdminIssueMemberRequest {
  name: string
  group?: string
  /** 缺省为 {@link ROLE_MEMBER}。 */
  role?: UserRole
}

/** 修改一个已有人员（`POST /api/v1/admin/members/update`）。token 不变。 */
export interface AdminUpdateMemberRequest {
  /** 定位用：要改的那个人当前持有的 token。 */
  token: string
  name?: string
  /** 传空串表示清除分组。 */
  group?: string
  role?: UserRole
}

/** 重置 token / 吊销（`.../rotate`、`.../revoke`）。 */
export interface AdminMemberTokenRequest {
  token: string
}

/** 管理员为已有成员开通或重置后台登录，独立于上报 Token。 */
export interface AdminLoginAccountRequest {
  token: string
  username: string
  password: string
}

/** 后台认证的公开身份，不含上报 Token。 */
export interface PortalViewer {
  member_id?: string
  /** 该账号所属分组的稳定 ID 与名称；多对多，未分组时为空数组。 */
  group_ids?: string[]
  group_names?: string[]
  roles?: import('./portal-identity.js').PortalRole[]
  permissions?: string[]
  name: string
  username: string
  /**
   * ⚠️ 已废弃的兼容别名，与「第一个分组名」同值，仅供旧页面显示。
   *   新代码读 `group_names`。
   */
  group?: string
  role: UserRole
}

export interface PortalLoginRequest {
  username: string
  password: string
  captcha_id: string
  captcha: string
}

export interface PortalSessionResponse {
  ok: boolean
  viewer?: PortalViewer
  reason?: string
}

export interface PortalCaptchaResponse {
  captcha_id: string
  image: string
  expires_in: number
}

/**
 * 签发 / 修改 / 重置 / 吊销的结果。
 *
 * ⚠️ 与 `/api/v1/identity/verify` 一样用 `200 + ok:false` 表达业务失败
 *   （重名、最后一个管理员不能删……），而**鉴权失败仍是 401/403/503**：
 *   这两类错误对使用者是完全不同的动作（改输入 vs 换 token）。
 */
export interface AdminMemberResponse {
  ok: boolean
  reason?: string
  /** 本次操作涉及的人员（含**新签发的 token**，供管理员复制转发）。 */
  member?: AdminMember
}
