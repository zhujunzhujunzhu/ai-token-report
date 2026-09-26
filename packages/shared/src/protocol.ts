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
export type GroupBy = 'provider' | 'model' | 'provider-model' | 'user' | 'project' | 'day' | 'hour'

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
}

export interface SeriesResponse {
  bucket: Bucket
  points: SeriesPoint[]
}

/** 分组排行的一行。 */
export interface BreakdownRow {
  key: string
  label?: string
  member_id?: string | null
  department_name?: string | null
  attribution_status?: import('./portal-identity.js').PortalAttributionStatus
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  calls: number
  cacheHitRate: number
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
  department_id?: string | null
  dept_snapshot?: string | null
  attribution_status?: import('./portal-identity.js').PortalAttributionStatus
  provider: string
  model: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cwd: string | null
}

export interface RecordsResponse {
  total: number
  limit: number
  offset: number
  rows: RecordRow[]
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
//      本地端用 `$DSH_HOME/token-report/usage.sqlite`（只含本机数据）。
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
 * 本地指标卡片（`GET /api/local/stats/overview`）。
 *
 * ★ 四项 token **分列**，与铁律 3 一致：采集端一旦合并，后续拆分无法还原。
 *   页面要展示「计费总量」时由前端相加或直接用 `totalTokens`，
 *   但**线上字段永远保持四个独立数字**。
 */
export interface LocalOverviewResponse {
  /** 实际统计窗口（服务端解析后的绝对时间，便于页面显示口径）。 */
  range: { from: number | null; to: number | null; label: string }
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
  dept: string | null
  createdAt: number | null
  /** 未署名时给出提示文案，由服务端决定，便于统一措辞。 */
  hint: string | null
}

/**
 * 提交署名（`POST /api/local/identity`）。
 *
 * ★ 服务端必须在此刻**向部门服务端校验 token**，校验通过才落盘。
 *   本地不做形式以外的判断。
 */
export interface LocalIdentitySubmit {
  name: string
  token: string
  dept?: string
}

/** 署名提交结果。 */
export interface LocalIdentitySubmitResponse {
  ok: boolean
  /** 失败原因，可直接展示给用户。 */
  reason?: string
  /** 成功后回显的姓名（供页面立即更新，无需再请求一次）。 */
  name?: string
  dept?: string
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
 */
export type UserRole = 'admin' | 'member'

/** 管理员：可看全部门看板，并可在管理页发放 / 重置 / 吊销 token。 */
export const ROLE_ADMIN: UserRole = 'admin'
/** 普通成员：可看全部门看板，看不到管理页。 */
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
  dept: string | null
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
  dept?: string
  /** 缺省为 {@link ROLE_MEMBER}。 */
  role?: UserRole
}

/** 修改一个已有人员（`POST /api/v1/admin/members/update`）。token 不变。 */
export interface AdminUpdateMemberRequest {
  /** 定位用：要改的那个人当前持有的 token。 */
  token: string
  name?: string
  /** 传空串表示清除部门。 */
  dept?: string
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
  department_id?: string | null
  department_name?: string | null
  roles?: import('./portal-identity.js').PortalRole[]
  permissions?: string[]
  name: string
  username: string
  dept?: string
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
