/**
 * 平台数据库身份契约。稳定人员 ID 与登录账号、上报凭证分离，
 * 普通响应只含凭证摘要提示，原始秘密仅出现在签发/轮换响应中。
 *
 * ★ **人员与分组是多对多**（`member_group_members`）：一个人可以同时属于
 *   多个分组，因此人员身上带的是 `groups` 数组而不是单个 ID。
 *   统计因而按「人员 → 分组」关联展开，一个事件会同时计入它的人员所属的每个分组。
 */

export type PortalMemberStatus = 'active' | 'disabled' | 'archived'
export type PortalGroupStatus = 'active' | 'disabled'
export type PortalAttributionStatus = 'member' | 'legacy' | 'unattributed'

export type PortalRoleStatus = 'active' | 'disabled'

/**
 * 角色 = 一组权限的命名集合。人员的权限是**他所持全部角色权限的并集**。
 *
 * ★ `code` 是稳定标识（建后不可改），`name` 才是可改的显示值：
 *   页面上的下拉、日志与审计都指 `role_id`，改个名字不该让它们失去指向。
 * ⚠️ `is_builtin` 为真时，权限定义与启停**不接受改写**（见服务端 `assertEditableRole`）：
 *   `admin` / `member` 既是缺省角色，也是兼容字段 `role: 'admin' | 'member'` 与
 *   「最后一个管理员」护栏的依托，允许改写等于把管理入口交给一次误操作。
 */
export interface PortalRole {
  role_id: string
  code: string
  name: string
  permissions: string[]
  is_builtin: boolean
  status: PortalRoleStatus
  version: number
}

/**
 * 权限目录里的一项。
 *
 * ★ 目录的**唯一真源是服务端 `permissions` 表**，随角色目录一起下发（同一读权限）。
 *   页面若自己硬编码一份可勾选清单，数据库里新增的权限就永远勾不上，
 *   而页面看起来「权限就这些」。
 */
export interface PortalPermission {
  code: string
  description: string
}

/** `GET /api/v1/admin/roles`：角色目录 + 可授予的权限目录，一次读全。 */
export interface PortalRoleListResponse {
  roles: PortalRole[]
  permissions: PortalPermission[]
}

/**
 * 新建角色。
 *
 * ⚠️ 新角色固定为**非内置**：内置标记只能由 schema seed 产生，
 *   若能从请求体给，页面就能造出一个「系统内置、不可修改」的角色。
 */
export interface PortalCreateRoleRequest {
  code: string
  name: string
  permission_codes: string[]
}

export interface PortalRoleVersionRequest {
  role_id: string
  expected_version: number
}

/**
 * 改角色名或权限。
 *
 * ⚠️ `permission_codes` 是**全量替换**而不是增量：给了它就是把该角色的权限集合
 *   设成这个列表。用增量语义的话，「取消掉最后一个权限」与「没动权限」
 *   在请求体里长得一模一样。
 */
export interface PortalRoleUpdateRequest extends PortalRoleVersionRequest {
  name?: string
  permission_codes?: string[]
}

export interface PortalRoleStatusRequest extends PortalRoleVersionRequest {
  status: PortalRoleStatus
}

export interface PortalGroup {
  group_id: string
  name: string
  status: PortalGroupStatus
  version: number
  created_at_ms: number
  updated_at_ms: number
}

/**
 * 人员所属分组的最小引用。
 *
 * ⚠️ 只带 ID 与名称，不带分组的版本号或启停状态：人员列表要的是「他属于哪些组」，
 *   把整份 `PortalGroup` 塞进来会让每次人员列表都顺带成为第二份分组目录读取口。
 */
export interface PortalMemberGroupRef {
  group_id: string
  name: string
}

export interface PortalMember {
  member_id: string
  name: string
  status: PortalMemberStatus
  /** 该人员当前所属的全部分组；多对多，空数组表示未分组。 */
  groups: PortalMemberGroupRef[]
  roles: PortalRole[]
  account: { username: string; enabled: boolean } | null
  active_token_count: number
  version: number
  created_at_ms: number
  updated_at_ms: number
}

export interface PortalReportToken {
  token_id: string
  member_id: string
  token_prefix: string
  label: string
  scopes: string[]
  status: 'active' | 'revoked'
  version: number
  created_at_ms: number
  expires_at_ms: number | null
  revoked_at_ms: number | null
}

/**
 * ★ appKey（插件/CLI 上报凭证）的权限**只有这两个接口**。
 *
 * | scope | 对应接口 | 用途 |
 * |---|---|---|
 * | `usage:write` | `POST /api/v1/token-usage` | 上报用量 |
 * | `stats:read` | `GET /api/v1/stats/*` | 获取统计信息 |
 *
 * 🚨 **常量而不是 UI 选项**：签发端点按它写库，页面拿它展示。
 *   若把范围交给请求体，就等于「页面写对了才有权限限制」——
 *   一个改过的请求就能签出带 `members:manage` 的 appKey。
 *
 * ⚠️ 刻意**不含** `identity:read`：appKey 的用途就是上报与取数，
 *   而 `/api/v1/identity/verify` 的校验同时接受 `usage:write`
 *   （见服务端 `verifyIdentity`），所以插件只填 appKey 也能拿到自己的署名。
 */
export const APP_KEY_SCOPES = ['usage:write', 'stats:read'] as const

/** appKey 在凭证列表里的缺省用途标签。 */
export const APP_KEY_LABEL = '上报 appKey'

/**
 * appKey 列表里的「发给谁」。
 *
 * ⚠️ 只带列表要呈现的四个字段，不塞整份 `PortalMember` ——
 *   把角色、登录账号、版本号一并带出来，等于让「凭证列表」顺带变成
 *   第二份人员档案读取口，而它的权限只校验 `tokens:manage`。
 */
export interface PortalAppKeyOwner {
  member_id: string
  name: string
  status: PortalMemberStatus
  groups: PortalMemberGroupRef[]
}

/**
 * 一行一把 appKey：凭证本体 + 它发给了谁。
 *
 * ★ 归属由服务端按 `report_tokens.member_id` 关联人员表得出，
 *   不从客户端的任何自称字段推断（与上报落库同一条原则）。
 * ⚠️ 这里**不含明文** —— 库里只有摘要，明文仅随签发 / 轮换响应返回一次。
 */
export interface PortalAppKeyEntry {
  token: PortalReportToken
  member: PortalAppKeyOwner
}

/** `GET /api/v1/admin/appkeys` 的响应体。 */
export interface PortalAppKeyListResponse {
  appkeys: PortalAppKeyEntry[]
}

/**
 * 签发 appKey。
 *
 * ⚠️ **没有 `scopes` 字段** —— 范围由服务端固定为 `APP_KEY_SCOPES`，
 *   调用方无法申请更宽的权限（与 `PortalIssueTokenRequest` 刻意区分开）。
 */
export interface PortalIssueAppKeyRequest {
  member_id: string
  label?: string
  expires_at_ms?: number | null
}

export interface PortalMutationResult {
  ok: boolean
  reason?: string
  code?: string
}

export interface PortalMemberResult extends PortalMutationResult {
  member?: PortalMember
}

export interface PortalTokenResult extends PortalMutationResult {
  token?: PortalReportToken
  /** 仅本次签发/轮换响应携带；关闭展示后无法找回，只能再次轮换。 */
  token_secret?: string
}

export interface PortalGroupResult extends PortalMutationResult {
  group?: PortalGroup
}

export interface PortalRoleResult extends PortalMutationResult {
  role?: PortalRole
}

export interface PortalCreateMemberRequest {
  name: string
  /** 建人时同时挂上的分组；缺省为未分组。 */
  group_ids?: string[]
  role_ids: string[]
}

export interface PortalMemberVersionRequest {
  member_id: string
  expected_version: number
}

/**
 * 改人名或改分组归属。
 *
 * ⚠️ `group_ids` 是**全量替换**而不是增量：给了它就是把该人员的分组集合
 *   设成这个列表。用增量语义的话，「移除最后一个分组」与「没传这个字段」
 *   在请求体里长得一模一样。
 */
export interface PortalUpdateMemberRequest extends PortalMemberVersionRequest {
  name?: string
  group_ids?: string[]
}

export interface PortalMemberRolesRequest extends PortalMemberVersionRequest {
  role_ids: string[]
}

export interface PortalMemberStatusRequest extends PortalMemberVersionRequest {
  status: PortalMemberStatus
}

export interface PortalLoginAccountRequest extends PortalMemberVersionRequest {
  username: string
  password: string
}

export interface PortalLoginStatusRequest extends PortalMemberVersionRequest {
  enabled: boolean
}

export interface PortalIssueTokenRequest {
  member_id: string
  label: string
  scopes?: string[]
  expires_at_ms?: number | null
}

export interface PortalTokenVersionRequest {
  member_id: string
  token_id: string
  expected_version: number
}

export interface PortalTokenScopesRequest extends PortalTokenVersionRequest {
  scopes: string[]
}

/**
 * 改已有凭证的有效期。
 *
 * ★ `null` 表示**长期有效**，其余必须是未来时刻 —— 与签发
 *   （`expires_at_ms?`）共用同一条校验，所以「续期」和「改成会过期」
 *   是同一个动作：`null` ⇄ 具体时刻。
 * ⚠️ 刻意与 `PortalTokenScopesRequest` 并列，而不是合成一个「更新凭证」
 *   请求：合起来就会让「只想续期」的调用顺手带上 `scopes`，而改范围与
 *   服务端固定的 appKey 范围（`APP_KEY_SCOPES`）是两件事。
 */
export interface PortalTokenExpiryRequest extends PortalTokenVersionRequest {
  expires_at_ms: number | null
}

export interface PortalGroupVersionRequest {
  group_id: string
  expected_version: number
}

export interface PortalAuditEntry {
  audit_id: string
  actor_member_id: string | null
  action: string
  target_type: string
  target_id: string | null
  result: string
  request_id: string | null
  metadata: Record<string, unknown>
  created_at_ms: number
}

export interface PortalAuditResponse {
  rows: PortalAuditEntry[]
  total: number
  limit: number
  offset: number
}

export interface PortalStorageResponse {
  kind: 'sqlite' | 'mysql'
  schema_version: number
  available: boolean
  initialized: boolean
}

export interface PortalLegacyAttribution {
  mapping_id: string
  legacy_user_id: string
  member_id: string | null
  status: 'pending' | 'mapped' | 'ignored'
  source_import_ref: string
  decision_reason: string | null
  decided_at_ms: number | null
  created_at_ms: number
}

export interface PortalConfirmLegacyRequest {
  mapping_id: string
  member_id: string
  expected_status: 'pending'
  source_import_ref: string
  reason: string
}

export interface PortalLegacyResult extends PortalMutationResult {
  mapping?: PortalLegacyAttribution
  updated_events?: number
}

/**
 * 一条供应商归一化规则（v6）。
 *
 * ★ 这是**查询期**的展示映射，不是对历史数据的改写：`usage_event.provider`
 *   永远是上报当时的原值，规则只决定「分组与筛选时按哪个名字算」。
 *   所以新增、修改、停用、删除都是即时生效且可逆的，没有回填这一步。
 */
export interface PortalProviderAlias {
  alias_id: string
  /** `global` 对所有人生效；`member` 只对该人员生效，逐条覆盖全局。 */
  scope: 'global' | 'member'
  /** `scope='member'` 时是那个人；`global` 时为 `null`。 */
  member_id: string | null
  /** 归属人姓名，仅用于列表展示（`scope='global'` 时为 `null`）。 */
  member_name: string | null
  /** 上报里出现的**原始** provider（大小写敏感的精确匹配）。 */
  provider: string
  /** 归一化后的展示名。 */
  alias: string
  /** 停用后这一条不参与归一化，但规则行仍在（可以随时启用回来）。 */
  enabled: boolean
  created_at_ms: number
  updated_at_ms: number
}

export interface PortalProviderAliasListResponse {
  aliases: PortalProviderAlias[]
}

export interface PortalProviderAliasResult extends PortalMutationResult {
  alias?: PortalProviderAlias
}

/**
 * 设置一条规则（upsert）。
 *
 * ⚠️ 同一 `(scope, member_id, provider)` 只有一条：再次提交是**改**而不是新增，
 *   否则同一个 provider 会有两条规则、结果取决于读取顺序。
 */
export interface PortalSetProviderAliasRequest {
  scope: 'global' | 'member'
  member_id?: string
  provider: string
  alias: string
  enabled?: boolean
}

export interface PortalProviderAliasIdRequest {
  alias_id: string
}

export interface PortalProviderAliasStatusRequest {
  alias_id: string
  enabled: boolean
}

// ---------------------------------------------------------------------------
// 模型单价（v7 `model_price`）—— 费用统计的唯一计价来源
// ---------------------------------------------------------------------------

/**
 * 一条模型单价。
 *
 * ★ **粒度是 `(provider, model)` 精确匹配，不是一个供应商一个价**：
 *   同一个供应商下不同模型的价差可以很大（旗舰与轻量模型常常差 10 倍以上），
 *   把供应商汇成一个价，必然有一半模型算错，而页面上只看得出「金额不对」。
 * ⚠️ 金额一律是**整数微元 / 千 token**（1 微 = 1e-6 货币单位）：
 *   用小数累加几十万行必然产生分位误差，而对账时那正是要命的位数。
 * 🚨 **换币种绝不换算、绝不相加**：不同 `currency` 的费用各自累加，
 *   展示时用 ` + ` 连接（见 `shared/price.ts` 的 `CostByCurrency`）。
 *   汇率是一个会随时间变的外部事实，把它烧进查询结果等于给历史数字埋雷。
 */
export interface PortalModelPrice {
  price_id: string
  provider: string
  model: string
  /** ISO 4217 三位大写（`USD` / `CNY`）。 */
  currency: string
  input_micro_per_ktok: number
  output_micro_per_ktok: number
  cache_read_micro_per_ktok: number
  cache_write_micro_per_ktok: number
  /**
   * 闲时（低谷）时段表 id；`null` = 这条价不分时段（全天一个价）。
   *
   * ★ 取值来自 `shared/price.ts` 的 `PRICE_SCHEDULES`（当前只有 `deepseek-cn`）。
   *   「哪段时间算高峰」在那张表里只有一份定义，服务端**只存 id**。
   */
  offpeak_schedule: string | null
  /**
   * 闲时四类单价；与 `offpeak_schedule` **同生共死**（要么五个都是 `null`，要么全都有值）。
   *
   * 🚨 缺一个就是「那一档按 0 元算」—— 0 是合法单价，计价函数不会报错，
   *   费用只是静默偏低。所以服务端写入前用 `offpeakConfigError()` 拒掉半套配置。
   */
  offpeak_input_micro_per_ktok: number | null
  offpeak_output_micro_per_ktok: number | null
  offpeak_cache_read_micro_per_ktok: number | null
  offpeak_cache_write_micro_per_ktok: number | null
  /** 生效起点（含），epoch 毫秒。 */
  effective_from_ms: number
  /** 生效终点（含）；`null` = 至今有效。 */
  effective_to_ms: number | null
  /** 备注：为什么是这个价（对账时最有用的一栏）。 */
  note: string | null
  created_at_ms: number
  updated_at_ms: number
}

export interface PortalModelPriceListResponse {
  prices: PortalModelPrice[]
}

export interface PortalModelPriceResult extends PortalMutationResult {
  price?: PortalModelPrice
}

/**
 * 设置一条单价（upsert）。
 *
 * ⚠️ 业务主键是 `(provider, model, effective_from_ms)`：同一个模型的同一个
 *   生效起点只有一行，再次提交是**改**而不是新增 ——
 *   否则同一个起点会有两个价，结果取决于读取顺序。
 * 🚨 **生效区间不得重叠**（同 `provider` + `model`，或「基础价与同名模型的专属价」
 *   之间 —— 见 `shared/price.ts` 的 `ANY_PROVIDER`）：重叠的两行会让
 *   「某一时刻该用哪个价」变成读取顺序问题。服务端显式查重并回 `409`，
 *   而不是任选一行 —— 唯一的例外是「同一 id 的自身更新」。
 *   ⚠️ 数据库那条 UNIQUE 索引**拦不住**这种情况（它只认完全相同的
 *   `effective_from_ms`），所以这条规则只有应用层兜着。
 *
 * ## `provider = '*'` = 不限供应商的基础价
 *
 * 它不满足供应商名的字符集（那条规则要求以字母 / 数字开头结尾），
 * 所以 zod 层与服务端都显式放行这一个值 —— 它**不是**供应商名，是保留值。
 * 解析时专属价优先、基础价兜底（`resolvePrice()`）。
 */
export interface PortalSetModelPriceRequest {
  provider: string
  model: string
  currency: string
  input_micro_per_ktok: number
  output_micro_per_ktok: number
  cache_read_micro_per_ktok: number
  cache_write_micro_per_ktok: number
  /**
   * 闲时档（v10）：`offpeak_schedule` 与四个单价**要么一起给、要么一起不给**。
   *
   * ⚠️ 省略 / `null` = 这条价不分时段。**旧客户端不发这几个字段是完全合法的** ——
   *   那是「全天一个价」，不是「漏配」。
   */
  offpeak_schedule?: string | null
  offpeak_input_micro_per_ktok?: number | null
  offpeak_output_micro_per_ktok?: number | null
  offpeak_cache_read_micro_per_ktok?: number | null
  offpeak_cache_write_micro_per_ktok?: number | null
  effective_from_ms: number
  effective_to_ms?: number | null
  note?: string | null
}

export interface PortalModelPriceIdRequest {
  price_id: string
}

/**
 * 用内置种子价初始化**空**的单价表。
 *
 * ★ 只在表为空时放行：它存在的意义是「刚部署完，一个价都没有」那一步。
 *   允许它对非空表执行，就等于把「覆盖我调好的价」做成一个按钮 ——
 *   而使用者点它的时候，多半以为自己在做别的事。
 */
export interface PortalSeedModelPricesRequest {
  confirm?: boolean
}
