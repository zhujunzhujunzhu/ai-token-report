/**
 * 请求体形状校验（zod）—— 服务端路由唯一的形状真源。
 *
 * ## 为什么在 `shared`，而且**只能**走子路径 `@ai-token-report/shared/schemas`
 *
 * 这些 schema 描述的是**线上契约**（`protocol.ts` 的 `WireTokenRecord` /
 * `Admin*Request`），放在契约包里才不会出现「字段改名了、校验没跟上」。
 * 但它们只被服务端用（`server/src/ingest-route.ts` / `admin-route.ts`）。
 *
 * 🚨 `src/index.ts` **绝不** re-export 本文件：`web-local` / `web-portal` /
 *    插件的浏览器半都 import `@ai-token-report/shared`，挂到主入口上等于
 *    把 zod 打进这三份前端产物 —— 体积涨了、行为不变，**没有任何东西会报错**。
 *    正确写法是显式走子路径：`from '@ai-token-report/shared/schemas'`。
 *    `verify/verify-schemas-not-bundled.ts` 兜住这条不变量：它既查根入口
 *    （⚠️ 实测 Vite 会摇掉「没人用」的 re-export，产物可能毫无变化，
 *    这时只有根因侧那条检查能立刻报出来），也扫三份真实产物。
 *
 * ## 🚨 这里的文案是对外契约，逐字保留
 *
 * 每个 schema 的 `error` 都是**重构前那条手写 `if (typeof …)` 的原话**：
 * 路由直接把它当 `reason` 回给前端 / CLI，`bun test` 与三个 e2e 都有断言。
 * 改文案前先想清楚「页面上会显示成什么」。
 *
 * ## 为什么把散落的手写校验收编成 schema
 *
 * 校验点原本散在 `ingest-route.ts` / `admin-route.ts`：每个字段一条 if，
 * 各自还维护一套 `nonEmptyString` / `optionalInt` 辅助函数 —— 两处的
 * 「非负整数」写法一旦漂移（trim 与否、是否容忍负数），**不会有任何东西报错**。
 * 现在形状只描述一次，路由只负责把「失败」翻译成 HTTP 状态码与响应体。
 *
 * ⚠️ **只收编 JSON 请求体的形状**：查询参数（`stats-route.ts` 的
 *    `period/bucket/by/from/to`、`local-api.ts` 的筛选）刻意不动 ——
 *    它们带「不许静默兜底」的语义，且收益低、风险高。
 *
 * ⚠️ **JSON 解析也不在这里**：空 body / 非法 JSON 的两种策略
 *    （`readJsonBodyStrict` / `readJsonBodyLenient`）由 `server/src/http/body.ts`
 *    负责，校验发生在**解析之后**、路由内部。
 */

import { z } from 'zod'

import { SCHEMA_VERSION } from './protocol.js'
import { validateName } from './identity.js'
import { ANY_PROVIDER } from './price.js'

/** 形状校验结果：要么给出归一化后的值，要么给出**可直接展示给排障者**的中文原因。 */
export type ShapeResult<T> = { ok: true; value: T } | { ok: false; reason: string }

// ─────────────────────────────────────────────────────────────
// 基础构件 —— 与重构前 `ingest-route.ts` 里那五个手写辅助函数逐条对应
// ─────────────────────────────────────────────────────────────

/** 必须是非空字符串，并去掉首尾空白（`event_id` / `session_id`）。 */
const trimmedNonEmptyString = z.string().trim().min(1)

/**
 * 非负整数。
 *
 * ⚠️ **绝不把缺失或非法值兜底成 0**：那会把「客户端漏字段」变成一条
 *    看起来完全正常的记录，用量悄悄少掉且无人发现。
 *
 * ★ 与手写版 `Number.isInteger(v) && v >= 0` 有一处**刻意的收紧**：
 *   zod 的 `z.int()` 额外要求安全整数（±(2^53-1)）；手写版会放行
 *   `ts: 1e300` 这种「是整数但显然是垃圾」的值。收到了只会污染时间窗，
 *   拒掉更合理 —— 这条差异写进了 `test/schemas.test.ts`。
 */
const nonNegativeInt = z.int().min(0)

/**
 * 是字符串就 trim，否则一律空串（`provider` / `model`）。
 *
 * 它们只影响分组展示、不影响用量本身，为它拒收整行会让客户端永远重发。
 */
const trimmedStringOrEmpty = z.string().trim().catch('')

/** 合法整数原样保留（**允许负数**），其余降级成 null（`turn` / `step`：纯元数据）。 */
const nullableInt = z.int().nullable().catch(null)

/** 是字符串就 trim 后保留，空串与非法类型都降级成 null（`cwd`：纯元数据）。 */
const nullableTrimmedString = z.string().trim().min(1).nullable().catch(null)

/**
 * 来源（`dsh` / `codex` / `claude-code` / `trae` / `trae-cn` / `workbuddy`）。
 *
 * ★ **只校验形状，不按注册表做严格枚举**：客户端比服务端新时（新来源已经发布、
 *   服务端还没升级）严格枚举会让**整批**上报被拒，而 CLI 会把 pending 一直重发 ——
 *   采集在那台机器上**永久停住**。未知值原样入库，并由 `/api/v1/stats/sources`
 *   与注册表取并集列出来，于是看板上既看得到、也筛得中。
 * ⚠️ 缺失 / 空串 / 超长 / 非法字符一律降级成 `null`，由入库路径按库内默认值
 *   `'dsh'` 兜底（v9 之前只有 DSH 上报过，所以那是事实而不是猜测）。
 * ⚠️ 形状限成 `[a-z0-9-]{1,32}`：它是**列值**也是分组键，放行空格 / 换行 / 超长
 *   会让分组里冒出看不出区别的几行，而 `usage_event.source` 上有 32 的长度上限 ——
 *   超长会被 MySQL 截断或报错（整批回滚、客户端无限重试）。
 */
const sourceOrNull = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,31}$/).nullable().catch(null)

// ─────────────────────────────────────────────────────────────
// 上报：POST /api/v1/token-usage
// ─────────────────────────────────────────────────────────────

/**
 * 一条上报记录（线上 snake_case 形状）。
 *
 * 🚨 **不含 `total_tokens`**（铁律 2）：上报库里没有这一列，它是四个分列之和
 *    的冗余副本。客户端照旧可以发它 —— `z.object` 会丢掉未声明的键，
 *    所以一个带错的 total 不会污染任何数字，也不会因为「total 与分列不等」
 *    而拒收一行本来正确的数据。
 *
 * ⚠️ 拒收标准刻意偏保守：被拒的行不会在客户端消失（CLI 会留在 `pending` 里
 *    反复重试），所以「可疑但能用」一律放行，只有**真的存不下去**才拒：
 *
 * | 字段 | 处理 |
 * |---|---|
 * | `event_id` / `session_id` / `seq` / `ts` | 必填且严格（没有幂等键就没法去重，没有时间戳就进不了任何时间窗） |
 * | 四个 token | 必填、非负整数（见上面的 ⚠️） |
 * | `reasoning_tokens` | 缺失即 0（它是 output 的子集，多数 provider 不下发） |
 * | `provider` / `model` | 兜底空串 |
 * | `cwd` / `turn` / `step` | 非法即 null |
 */
export const ingestRecordSchema = z.object({
  event_id: trimmedNonEmptyString,
  session_id: trimmedNonEmptyString,
  seq: nonNegativeInt,
  ts: nonNegativeInt,
  provider: trimmedStringOrEmpty,
  model: trimmedStringOrEmpty,
  input_tokens: nonNegativeInt,
  output_tokens: nonNegativeInt,
  cache_read_tokens: nonNegativeInt,
  cache_write_tokens: nonNegativeInt,
  reasoning_tokens: nonNegativeInt.catch(0),
  cwd: nullableTrimmedString,
  turn: nullableInt,
  step: nullableInt,
  // ★ v9：哪台客户端写的。缺失即 null ⇒ 入库按 `'dsh'` 兜底（见 `sourceOrNull`）。
  source: sourceOrNull,
})

/** 校验通过后的归一化结果 —— 与 `core/db` 的 `IngestRecord` 逐字段一致。 */
export type ParsedIngestRecord = z.infer<typeof ingestRecordSchema>

/**
 * 上报载荷的**外层**形状：对象 / `schemaVersion` 是整数且不高于本服务端 / `records` 是数组。
 *
 * ★ 版本上限用**字段级** `refine`，而不是「解析完再单独判一次」：
 *   这样「版本过高」与「缺 records」同时出现时，报的仍然是版本错误 ——
 *   与重构前那条手写 if 链的先后顺序逐字一致。版本号是定位问题的关键信息，
 *   被一句无关的「records 应为数组」盖掉，排障方向会完全跑偏
 *   （`e2e-ingest.ts` 断言 reason 里带 `99`）。
 *
 * ★ 缺省（不传 `schemaVersion`）按当前版本处理：新旧客户端混跑时，
 *   不会因为一个可选字段互相拒绝。
 *
 * ⚠️ 未声明的键（`client` / `generatedAt`）会被 `z.object` 丢掉 —— 这正是
 *   想要的：归属只信服务端，请求体里的 `client.userName` 一律不进任何逻辑。
 */
export const ingestEnvelopeSchema = z.object(
  {
    schemaVersion: z
      .int({ error: 'schemaVersion 应为整数' })
      .refine((v) => v <= SCHEMA_VERSION, {
        error: (issue) =>
          `上报协议版本 ${String(issue.input)} 高于本服务端支持的 ${SCHEMA_VERSION}，请升级服务端`,
      })
      .optional(),
    records: z.array(z.unknown(), { error: 'records 应为数组' }),
  },
  { error: '请求体应为 JSON 对象' },
)

/** ⚠️ 顺序即优先级，与重构前的检查顺序一致。 */
const ENVELOPE_PRIORITY = [null, 'schemaVersion', 'records'] as const

/**
 * 校验上报载荷的外层。
 *
 * 返回的只有 `records`（原始元素）：单行的严格校验交给
 * {@link ingestRecordSchema}，因为两者的失败语义完全不同 ——
 * 外层失败是**整批** 400，单行失败只是 `rejected++`（其余行照常入库）。
 */
export function parseIngestEnvelope(value: unknown): ShapeResult<{ records: unknown[] }> {
  const parsed = ingestEnvelopeSchema.safeParse(value)
  if (!parsed.success) {
    return { ok: false, reason: reasonOf(parsed.error, ENVELOPE_PRIORITY) }
  }
  return { ok: true, value: { records: parsed.data.records } }
}

// ─────────────────────────────────────────────────────────────
// 人员管理：/api/v1/admin/members*
// ─────────────────────────────────────────────────────────────
//
// ⚠️ 这里**只查形状**。空姓名、未知角色、重名、最后一个管理员不能删……
//    全是**业务**失败，由 `member-admin.ts` 判定并回 `200 + ok:false`。
//    把业务规则搬进形状校验，只会让「改输入」和「换 token」两类错误
//    在页面上混成同一句话（见 admin-route.ts 文件头）。

/**
 * 定位用的人员 token 字段：必须是字符串，且 trim 后非空。
 *
 * ⚠️ 只校验、**不 trim 输出** —— 下游 `MemberAdmin` 拿到的仍是原始值，
 *    与重构前 `readToken()` 的行为逐字一致。
 */
function tokenField(reason: string) {
  return z
    .string({ error: reason })
    .refine((s) => s.trim().length > 0, { error: reason })
}

/** `POST /api/v1/admin/members` —— 签发。 */
export const adminIssueBodySchema = z.object(
  {
    name: z.string({ error: '缺少 name（要发放 token 的姓名）' }),
    group: z.string({ error: 'group 需要是字符串' }).optional(),
    // ⚠️ 角色只查类型，取值合法性留给 member-admin 的 normalizeRole()
    //    （它要报「未知角色「x」，只支持 admin / member」这句业务文案）
    role: z.string({ error: 'role 需要是字符串' }).optional(),
  },
  { error: '请求体需要是一个对象' },
)

/** `POST /api/v1/admin/members/update` —— 改名 / 换分组 / 调角色。 */
export const adminUpdateBodySchema = z.object(
  {
    token: tokenField('缺少 token（要修改哪个人）'),
    name: z.string({ error: 'name 需要是字符串' }).optional(),
    group: z.string({ error: 'group 需要是字符串' }).optional(),
    role: z.string({ error: 'role 需要是字符串' }).optional(),
  },
  { error: '请求体需要是一个对象' },
)

/** `POST /api/v1/admin/members/rotate` / `revoke` —— 只需要一个 token。 */
export const adminTokenBodySchema = z.object(
  { token: tokenField('缺少 token（要操作哪个人）') },
  { error: '请求体需要是一个对象' },
)

/** `POST /api/v1/admin/members/login` —— 开通 / 重置后台账号。 */
export const adminLoginBodySchema = z.object(
  {
    token: tokenField('缺少 token（要操作哪个人）'),
    username: z.string({ error: 'username 与 password 需要是字符串' }),
    password: z.string({ error: 'username 与 password 需要是字符串' }),
  },
  { error: '请求体需要是一个对象' },
)

export type AdminIssueBody = z.infer<typeof adminIssueBodySchema>
export type AdminUpdateBody = z.infer<typeof adminUpdateBodySchema>
export type AdminTokenBody = z.infer<typeof adminTokenBodySchema>
export type AdminLoginBody = z.infer<typeof adminLoginBodySchema>

export function parseAdminIssueBody(value: unknown): ShapeResult<AdminIssueBody> {
  return check(adminIssueBodySchema, [null, 'name', 'group', 'role'], value)
}

export function parseAdminUpdateBody(value: unknown): ShapeResult<AdminUpdateBody> {
  return check(adminUpdateBodySchema, [null, 'token', 'name', 'group', 'role'], value)
}

export function parseAdminTokenBody(value: unknown): ShapeResult<AdminTokenBody> {
  return check(adminTokenBodySchema, [null, 'token'], value)
}

export function parseAdminLoginBody(value: unknown): ShapeResult<AdminLoginBody> {
  return check(adminLoginBodySchema, [null, 'token', 'username', 'password'], value)
}

// 数据库身份接口使用严格对象，旧的 token 定位载荷不能被静默当成新版请求。
const portalId = z.uuid({ error: '需要有效的对象 ID，请刷新页面' })
const portalVersion = z.int().min(1, { error: '缺少有效的 expected_version，请刷新页面' })
const portalName = z.string().superRefine((value, ctx) => {
  const result = validateName(value)
  if (!result.ok) ctx.addIssue({ code: 'custom', message: result.reason ?? '姓名不合法' })
}).transform((value) => value.trim())
const roleIds = z.array(portalId).min(1).max(32)
const scopes = z.array(z.string().min(1).max(64)).min(1).max(64)
const memberVersion = { member_id: portalId, expected_version: portalVersion }
const tokenVersion = { ...memberVersion, token_id: portalId }
const groupVersion = { group_id: portalId, expected_version: portalVersion }
/** 人员与分组是多对多：一次最多挂 64 个分组，去重后由仓储整组替换。 */
const groupIds = z.array(portalId).max(64)
const groupName = z.string().min(1).max(64).refine(
  (name) => !!name.trim() && !/[\r\n\t]/.test(name), { error: '分组名称不能为空或包含换行、制表符' },
).transform((name) => name.trim())

export const portalCreateMemberSchema = z.strictObject({
  name: portalName, group_ids: groupIds.optional(), role_ids: roleIds,
})
export const portalUpdateMemberSchema = z.strictObject({
  ...memberVersion, name: portalName.optional(), group_ids: groupIds.optional(),
}).refine((value) => value.name !== undefined || value.group_ids !== undefined, {
  error: '至少提供姓名或分组',
})
export const portalMemberRolesSchema = z.strictObject({ ...memberVersion, role_ids: roleIds })
export const portalMemberStatusSchema = z.strictObject({
  ...memberVersion, status: z.enum(['active', 'disabled', 'archived']),
})
export const portalLoginAccountSchema = z.strictObject({
  ...memberVersion, username: z.string().min(3).max(64), password: z.string().min(1).max(256),
})
export const portalLoginStatusSchema = z.strictObject({ ...memberVersion, enabled: z.boolean() })
export const portalIssueTokenSchema = z.strictObject({
  member_id: portalId, label: z.string().trim().min(1).max(128), scopes: scopes.optional(),
  expires_at_ms: z.int().positive().nullable().optional(),
})
/**
 * 签发 appKey。
 *
 * ⚠️ `strictObject` 在这里是**安全边界**：请求体里多写一个 `scopes`
 *   会被判 400，而不是被静默忽略 —— 否则「页面传了更宽的范围但没生效」
 *   与「页面传了更宽的范围且生效了」在日志上长得一模一样。
 *   权限范围由服务端固定（`APP_KEY_SCOPES`），这里连字段都不给。
 */
export const portalIssueAppKeySchema = z.strictObject({
  member_id: portalId, label: z.string().trim().min(1).max(128).optional(),
  expires_at_ms: z.int().positive().nullable().optional(),
})
export const portalTokenVersionSchema = z.strictObject(tokenVersion)
export const portalTokenScopesSchema = z.strictObject({ ...tokenVersion, scopes })
/**
 * 改有效期。
 *
 * 🚨 `expires_at_ms` 在这里是**必填**（可以是 `null`）：`null` 表示长期有效，
 *   而不是「没给」。若做成可选，漏传字段就会被服务端当成「清空到期时间」——
 *   一个把短效 key 悄悄变成长效 key 的默认值。
 */
export const portalTokenExpirySchema = z.strictObject({
  ...tokenVersion, expires_at_ms: z.int().positive().nullable(),
})
export const portalCreateGroupSchema = z.strictObject({ name: groupName })
export const portalUpdateGroupSchema = z.strictObject({ ...groupVersion, name: groupName })
export const portalGroupStatusSchema = z.strictObject({
  ...groupVersion, status: z.enum(['active', 'disabled']),
})
/**
 * 供应商名（原始名与归一化名各一套规则）。
 *
 * ⚠️ 规则必须与 core 的 `providerNameError()` / `aliasNameError()` **同值**：
 *   前端在提交前先拦一次是为了给出即时反馈，服务端那一次才是安全边界。
 *   两处不一致的表现是「页面说不行、接口说行」（或反过来），
 *   而使用者只会觉得这个功能时好时坏。
 */
const invisibleCharacters = /[\u0000-\u001f\u007f\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/
const providerName = z.string().min(1, { error: '供应商名不能为空' }).max(128, { error: '供应商名不能超过 128 个字符' })
  .refine((value) => !invisibleCharacters.test(value), { error: '供应商名不能包含空格以外的空白或不可见字符' })
  .refine((value) => /^[A-Za-z0-9](?:[A-Za-z0-9 ._:/+-]{0,126}[A-Za-z0-9._:/+-])?$/.test(value), {
    error: '供应商名需要以字母或数字开头和结尾，只能包含字母、数字与空格 . _ : / + -',
  })
/**
 * **带保留值 `'*'` 的供应商名**，供两处使用：
 *
 * 1. **单价行**：`'*'` = 不限供应商的基础价（任何没有专属价的供应商都落它）；
 * 2. **归一化规则**：`'*'` = 任意供应商（模型规则里的「不管哪家报的，
 *    这个模型名都折叠成同一个展示名」）。
 *
 * 🚨 它与 `providerName` 刻意分开：`providerName` 描述的是**上报里真实存在的供应商名**
 * （它必须匹配 `usage_event.provider` 的值域），而 `'*'` 永远不会出现在用量里。
 * 把 `'*'` 塞进 `providerName` 会让「建一条叫 `*` 的供应商归一化规则」这类无意义动作
 * 变得合法，而它只会得到一条永远匹配不到任何用量的规则。
 *
 * ★ 两处**共用这一个定义**：它们匹配的都是 `usage_event.provider` 的值域，
 *   各写一遍必然分叉，而分叉的表现是「单价填得进去、规则填不进去」。
 */
const starOrProviderName = z.union([
  z.literal(ANY_PROVIDER, { error: '供应商名无效' }),
  providerName,
])
/**
 * 模型标识。
 *
 * ⚠️ 与 `providerName` **分开**，不能沿用它的字符集：模型 ID 里出现 `/` 是常态
 * （`deepseek/deepseek-chat` 这类网关前缀），而 `providerName` 恰好禁止 `/`。
 * 字符集刻意宽松（只禁不可见字符、要求首尾无空格）—— 模型名由各供应商自己定，
 * 卡死了只会让新模型录不进来，而录入者唯一的办法是改代码。
 *
 * ★ 同一个定义同时服务**单价行**与**归一化规则里的模型名**：两处匹配的都是
 *   `usage_event.model` 这个值域，一套规则即可。
 *
 * ⚠️ 长度上限 255 与 `provider_alias` 的 CHECK（`PORTAL_MODEL_MAX_LENGTH`）
 *   以及 core 的 `modelNameError()` 是**同一个数**。
 */
const modelName = z.string().min(1, { error: '模型名不能为空' }).max(255, { error: '模型名不能超过 255 个字符' })
  .refine((value) => !invisibleCharacters.test(value), { error: '模型名不能包含空格以外的空白或不可见字符' })
  .refine((value) => value === value.trim(), { error: '模型名首尾不能是空格' })
/**
 * 单价行的**闲时时段表 id**。取值由服务端对照 `PRICE_SCHEDULES` 校验
 * （这里只卡形状 —— 时段表是代码里的常量，不是这一层能穷举的东西）。
 */
const offpeakScheduleId = z.string().min(1, { error: '闲时时段表 id 不能为空' }).max(64, { error: '闲时时段表 id 不能超过 64 个字符' })
/** ★ 归一化名允许中文 —— 它是给人看的名字，而 `阿里百炼` 比 `bailian-tpp` 更好读。 */
const aliasName = z.string().min(1, { error: '归一化名不能为空' }).max(128, { error: '归一化名不能超过 128 个字符' })
  .refine((value) => !invisibleCharacters.test(value), { error: '归一化名不能包含空格以外的空白或不可见字符' })
  .refine((value) => !/^ | $/.test(value), { error: '归一化名首尾不能是空格' })
  .refine((value) => !value.includes('/'), { error: '归一化名不能包含 /（它是 provider 与 model 的分隔符）' })
/**
 * 设置一条归一化规则（upsert）。
 *
 * ★ `member_id` 只在 `scope='member'` 时有意义，这里做成可选而不是联锁校验：
 *   真正的联锁在服务端（`setProviderAlias` 按 scope 决定取值），
 *   在这一层做「scope 与 member_id 必须同时出现」会让前端多写一段状态机，
 *   而它并不比服务端那一行更可靠。
 */
export const portalSetProviderAliasSchema = z.strictObject({
  scope: z.enum(['global', 'member']),
  member_id: portalId.optional(),
  provider: providerName,
  alias: aliasName,
  enabled: z.boolean().optional(),
})
export const portalProviderAliasIdSchema = z.strictObject({ alias_id: portalId })
export const portalProviderAliasStatusSchema = z.strictObject({ alias_id: portalId, enabled: z.boolean() })
/**
 * 模型标识。
 *
 * ⚠️ 与 `providerName` **分开**，不能沿用它的字符集：模型 ID 里出现 `/` 是常态
 *   （`deepseek/deepseek-chat` 这类网关前缀），而 `providerName` 恰好禁止 `/`。
 *   字符集刻意宽松（只禁不可见字符、要求首尾无空格）—— 模型名由各供应商自己定，
 *   卡死了只会让新模型录不进来，而录入者唯一的办法是改代码。
 */
const modelName = z.string().min(1, { error: '模型名不能为空' }).max(255, { error: '模型名不能超过 255 个字符' })
  .refine((value) => !invisibleCharacters.test(value), { error: '模型名不能包含空格以外的空白或不可见字符' })
  .refine((value) => value === value.trim(), { error: '模型名首尾不能是空格' })
/** ISO 4217 三位大写 —— 与库里那条 CHECK（`^[A-Z]{3}$`）逐字一致。 */
const currencyCode = z.string().regex(/^[A-Z]{3}$/, { error: '币种需要是三位大写字母的 ISO 4217 代码（如 USD、CNY）' })
/**
 * 单价：**整数微元 / 千 token**（1 微 = 1e-6 货币单位）。
 *
 * 🚨 上限与服务端常量 `MAX_MICRO_PER_KTOK`（1e7）**必须一致**，
 *   而且库里的 CHECK 也是同一个数：这一层放松就会「填得进去、保存时报 500」；
 *   这一层收紧就会让一个库里合法的价改不回去。
 *   1e7 微/Ktok = 10 货币单位/千 token，是现实最贵模型的数百倍余量。
 */
const microPerKtok = z.int({ error: '单价需要是整数微元' }).min(0, { error: '单价不能是负数' })
  .max(10_000_000, { error: '单价上限是 10000000 微元/千 token（约 10 货币单位/千 token）' })
/** epoch 毫秒；与 `usage_event` 各时间列同一形状（非负安全整数）。 */
const epochMs = z.int({ error: '时间需要是 epoch 毫秒' }).min(0, { error: '时间不能是负数' })
/**
 * 设置一条单价（upsert）。
 *
 * ⚠️ `effective_to_ms` 允许 `null`（至今有效）与省略（同 `null`）两种写法：
 *   页面清空结束时间就是 `null`，而脚本常常干脆不写这个字段。
 * 🚨 **区间重叠由服务端查重兜住**（回 `409`），不在这一层做 ——
 *   这里拿不到库里已有的行，判断重叠必须读库。
 */
export const portalSetModelPriceSchema = z.strictObject({
  provider: starOrProviderName,
  model: modelName,
  currency: currencyCode,
  input_micro_per_ktok: microPerKtok,
  output_micro_per_ktok: microPerKtok,
  cache_read_micro_per_ktok: microPerKtok,
  cache_write_micro_per_ktok: microPerKtok,
  // ★ 闲时档（v10）：五个字段都可选 —— 省略 / `null` = 这条价不分时段。
  //   「五列同进同出」由服务端用 `offpeakConfigError()` 校验（它要读时段表，
  //   而时段表不在这一层的可见范围内）。
  offpeak_schedule: offpeakScheduleId.nullable().optional(),
  offpeak_input_micro_per_ktok: microPerKtok.nullable().optional(),
  offpeak_output_micro_per_ktok: microPerKtok.nullable().optional(),
  offpeak_cache_read_micro_per_ktok: microPerKtok.nullable().optional(),
  offpeak_cache_write_micro_per_ktok: microPerKtok.nullable().optional(),
  effective_from_ms: epochMs,
  effective_to_ms: epochMs.nullable().optional(),
  note: z.string().max(255, { error: '备注不能超过 255 个字符' }).nullable().optional(),
})
export const portalModelPriceIdSchema = z.strictObject({ price_id: portalId })
/**
 * 用内置种子价初始化空表。
 *
 * ⚠️ `confirm` 必须是显式 `true`：这是一个会**写库**的动作，
 *   省略字段就执行等于「一个空 body 的 POST 也能改数据」。
 */
export const portalSeedModelPricesSchema = z.strictObject({ confirm: z.boolean().optional() })
/**
 * 角色标识。
 *
 * ★ 建后不可改，所以这里必须一次卡死格式：它是稳定标识，将来若允许中文或大写，
 *   「同一个角色」会在日志与审计里出现两种写法，而页面看不出这是同一个。
 */
const roleCode = z.string().min(1, { error: '角色标识不能为空' }).max(64, { error: '角色标识不能超过 64 个字符' }).refine(
  (code) => /^[a-z][a-z0-9_.:-]*$/.test(code),
  { error: '角色标识需要以字母开头，只能使用小写字母、数字与 _ . : -' },
)
const roleName = z.string().min(1, { error: '角色名称不能为空或包含换行、制表符' }).max(128, { error: '角色名称不能超过 128 个字符' }).refine(
  (name) => !!name.trim() && !/[\r\n\t]/.test(name), { error: '角色名称不能为空或包含换行、制表符' },
).transform((name) => name.trim())
/** 权限码由服务端目录校验，这里只负责形状；空数组合法（先建空角色、之后再授权）。 */
const permissionCodes = z.array(z.string().min(1).max(64)).max(64)
const roleVersion = { role_id: portalId, expected_version: portalVersion }
export const portalCreateRoleSchema = z.strictObject({
  code: roleCode, name: roleName, permission_codes: permissionCodes,
})
export const portalUpdateRoleSchema = z.strictObject({
  ...roleVersion, name: roleName.optional(), permission_codes: permissionCodes.optional(),
}).refine((value) => value.name !== undefined || value.permission_codes !== undefined, {
  error: '至少提供角色名称或权限',
})
export const portalRoleStatusSchema = z.strictObject({
  ...roleVersion, status: z.enum(['active', 'disabled']),
})
export const portalConfirmLegacySchema = z.strictObject({
  mapping_id: portalId, member_id: portalId, expected_status: z.literal('pending'),
  source_import_ref: z.string().min(1).max(128), reason: z.string().trim().min(1).max(512),
})

/** 新管理接口共用校验出口，不改变既有上报与署名的错误优先级。 */
export function parsePortalBody<T extends z.ZodType>(schema: T, value: unknown): ShapeResult<z.infer<T>> {
  return check(schema, [null, 'member_id', 'token_id', 'group_id', 'group_ids', 'role_id', 'code', 'permission_codes', 'expected_version'], value)
}

// ─────────────────────────────────────────────────────────────
// 内部：把 zod 的错误翻译成「这一层该报的那一句话」
// ─────────────────────────────────────────────────────────────

/**
 * 按**显式优先级**挑出要展示的那条 issue。
 *
 * ⚠️ 为什么不直接取 `issues[0]`：zod 的 issue 顺序是实现细节，而这里的文案
 *    是对外契约。显式写出优先级，顺带与重构前那条手写 if 链一一对应 ——
 *    以后调整字段顺序也不会悄悄换掉提示语。
 *
 * 🚨 优先级表里的 `null` 代表**根级**错误（请求体本身不是对象）。
 */
function reasonOf(error: z.ZodError, priority: readonly (string | null)[]): string {
  for (const key of priority) {
    const hit = error.issues.find((issue) =>
      key === null ? issue.path.length === 0 : String(issue.path[0]) === key,
    )
    if (hit) return hit.message
  }
  // 兜底：将来新增字段却忘了进优先级表时，宁可给出 zod 的原始提示，
  // 也不要回一个空字符串（前端会渲染成一句没有内容的「操作失败」）
  return error.issues[0]?.message ?? '请求体形状不合法'
}

/** 校验 + 翻译文案的公共壳，四个 admin 解析器共用。 */
function check<T extends z.ZodType>(
  schema: T,
  priority: readonly (string | null)[],
  value: unknown,
): ShapeResult<z.infer<T>> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) return { ok: false, reason: reasonOf(parsed.error, priority) }
  return { ok: true, value: parsed.data }
}
