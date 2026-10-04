/**
 * 上报库 v13 追加：**把 `cost:read` 授予内置 `member` 角色** —— 纯权限版本，**不含任何 DDL**。
 *
 * ## 为什么必须给
 *
 * `APP_KEY_SCOPES`（`shared/src/portal-identity.ts`）2026-10 起是三项：
 * `usage:write` + `stats:read` + **`cost:read`** —— 插件面板与 CLI 要靠**线上那份价**
 * 算金额，而 appKey 是它们手上唯一的凭证。
 *
 * 但「一份凭证能做什么」在本仓由**两条**约束的交集决定：
 *   1. 签发时 `IdentityRepository.grantScopes()`：本次授予必须是**目标角色**权限的子集；
 *   2. 解析时 `IdentityRepository` 的 bearer 解析：`权限 = 角色权限 ∩ 凭证 scopes`。
 *
 * 内置 `member` 角色此前**刻意**没有 `cost:read`（v7 的注释：费用能反推预算与议价空间），
 * 于是把这一项加进 appKey 会立刻露馅：**普通成员一条 appKey 都签不出来**
 * （第 1 条直接 403），而签得出来的也读不到价（第 2 条把它交掉了）。
 *
 * ## 放开的口径是「全员价目表」，不是「全员用量」
 *
 * `cost:read` 只够读 `GET /api/v1/stats/pricing` 的**只读单价快照**
 * （一行行价，不含任何用量）；用量本身仍由数据范围收窄
 * （非内置管理员只看本人）。这两件事在权限码上本来就是分开的。
 *
 * ## 为什么是「纯权限版本」（这个版本不动任何受控 DDL）
 *
 * 权限是**数据**，不是结构 —— `portalSchemaChecksum()` 刻意只覆盖 DDL 文本
 * （见那里的注释：把权限算进摘要会让「手工补了一条角色权限」把库判成「结构不符」）。
 * 所以本版本：
 *   - 不新增/修改任何表、列、索引 ⇒ `portalSchemaChecksum()` 的算式**一个字都不动**；
 *   - 也因此**不需要** v13 自己的摘要输入函数；
 *   - 但 `portalSchemaChecksumV12()` 仍然要**冻结**（= v13 发布那一刻的结构摘要）：
 *     将来某一版真的加了 DDL，`portalSchemaChecksum()` 会变，而 v12 库必须继续
 *     被认成「结构是上一版、完整、可迁移」。
 *
 * ⚠️ 与 v11 的权限 SQL 同款：**幂等靠 SQL 自身**（`WHERE NOT EXISTS`）。
 *   MySQL 侧本版本没有 DDL ⇒ 没有隐式提交，但中途崩掉仍可能只写了一半，
 *   重跑必须安全。
 */

/** 内置 `member` 角色（与 v4 的 seed 同一个字面量）。 */
const MEMBER_ROLE_ID = '00000000-0000-4000-8000-000000000002'

/** `cost:read` 权限行（v7 起就在 `permissions` 里）。 */
const COST_READ_PERMISSION_ID = '00000000-0000-4000-8000-000000000114'

/**
 * v13 的全部语句：**只有一条**，给内置 `member` 角色补上 `cost:read` —— 没有一句 DDL。
 *
 * ⚠️ **刻意不再补 `permissions` 那行**：v7（`PORTAL_V7_PERMISSION_SQL`）已经幂等地
 *   保证 `cost:read`（`…114`）这行权限存在，而两个版本里出现**逐字相同**的 SQL
 *   会让受控语句清单里出现两份 —— 那正是 `portal-v13.test.ts` 要钉住的东西。
 *
 * 两种后端**逐字相同**（`role_permissions` 的列在两个后端上一致），所以不需要 `kind`。
 */
export const PORTAL_V13_PERMISSION_SQL: readonly string[] = [
  `INSERT INTO role_permissions (role_id,permission_id) SELECT '${MEMBER_ROLE_ID}','${COST_READ_PERMISSION_ID}' WHERE NOT EXISTS (SELECT 1 FROM role_permissions WHERE role_id='${MEMBER_ROLE_ID}' AND permission_id='${COST_READ_PERMISSION_ID}')`,
]

/**
 * v13 的语句清单（供 `portalSchemaStatements()` 拼接与 v12→v13 迁移共用）。
 *
 * ★ 两处**必须是同一份**：`portalSchemaStatements()` 决定「新建的库」长什么样，
 *   迁移决定「已有库」升完长什么样 —— 各写一份的结果是两种库不一致，
 *   而它不会报错，只会在某人签 appKey 时 403。
 */
export function portalV13Statements(): string[] {
  return [...PORTAL_V13_PERMISSION_SQL]
}
