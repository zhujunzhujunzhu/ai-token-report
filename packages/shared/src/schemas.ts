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
    dept: z.string({ error: 'dept 需要是字符串' }).optional(),
    // ⚠️ 角色只查类型，取值合法性留给 member-admin 的 normalizeRole()
    //    （它要报「未知角色「x」，只支持 admin / member」这句业务文案）
    role: z.string({ error: 'role 需要是字符串' }).optional(),
  },
  { error: '请求体需要是一个对象' },
)

/** `POST /api/v1/admin/members/update` —— 改名 / 换部门 / 调角色。 */
export const adminUpdateBodySchema = z.object(
  {
    token: tokenField('缺少 token（要修改哪个人）'),
    name: z.string({ error: 'name 需要是字符串' }).optional(),
    dept: z.string({ error: 'dept 需要是字符串' }).optional(),
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
  return check(adminIssueBodySchema, [null, 'name', 'dept', 'role'], value)
}

export function parseAdminUpdateBody(value: unknown): ShapeResult<AdminUpdateBody> {
  return check(adminUpdateBodySchema, [null, 'token', 'name', 'dept', 'role'], value)
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
const departmentVersion = { department_id: portalId, expected_version: portalVersion }
const departmentName = z.string().min(1).max(64).refine(
  (name) => !!name.trim() && !/[\r\n\t]/.test(name), { error: '部门名称不能为空或包含换行、制表符' },
).transform((name) => name.trim())

export const portalCreateMemberSchema = z.strictObject({
  name: portalName, department_id: portalId.nullable().optional(), role_ids: roleIds,
})
export const portalUpdateMemberSchema = z.strictObject({
  ...memberVersion, name: portalName.optional(), department_id: portalId.nullable().optional(),
}).refine((value) => value.name !== undefined || value.department_id !== undefined, {
  error: '至少提供姓名或部门',
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
export const portalTokenVersionSchema = z.strictObject(tokenVersion)
export const portalTokenScopesSchema = z.strictObject({ ...tokenVersion, scopes })
export const portalCreateDepartmentSchema = z.strictObject({ name: departmentName })
export const portalUpdateDepartmentSchema = z.strictObject({ ...departmentVersion, name: departmentName })
export const portalDepartmentStatusSchema = z.strictObject({
  ...departmentVersion, status: z.enum(['active', 'disabled']),
})
export const portalConfirmLegacySchema = z.strictObject({
  mapping_id: portalId, member_id: portalId, expected_status: z.literal('pending'),
  source_import_ref: z.string().min(1).max(128), reason: z.string().trim().min(1).max(512),
})

/** 新管理接口共用校验出口，不改变既有上报与署名的错误优先级。 */
export function parsePortalBody<T extends z.ZodType>(schema: T, value: unknown): ShapeResult<z.infer<T>> {
  return check(schema, [null, 'member_id', 'token_id', 'department_id', 'expected_version'], value)
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
