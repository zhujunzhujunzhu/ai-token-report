/**
 * 上报库 v9 追加：**给事实表补一列 `usage_event.source`**（这条用量是哪个客户端写的）。
 *
 * ## 为什么这一版与前四版的形状不同（它动的是**既有表**）
 *
 * v6 / v7 / v8 都是「只加表」，所以受控定义 = v5 文本 + 追加的 CREATE TABLE。
 * v9 要在 `usage_event` 上加一列，而 **v5 的 DDL 文本一个字都不许改**：
 *   `portalSchemaChecksumV6/V7` 是按 v5 文本的**当前全文**求摘要的（见那两个函数的注释），
 *   改动它会让已经迁到 v6 / v7 的库（包括线上库）从「可迁移的起点」变成
 *   `unsupported` —— 服务端直接拒绝启动，而实际上它们只差一次追加迁移。
 *
 * 所以这一列**不写进 v5 的常量**，而是由本模块提供一个**拼接**：
 * 受控定义里的 `usage_event` = v5 的原文 + 这个列定义，插在
 * **最后一个列定义之后、第一条表级约束之前**。
 *
 * 🚨 那个插入点是**被 SQLite 的改写规则钉住的**，不是排版偏好：
 *   SQLite 不支持 `ALTER TABLE ... ADD COLUMN` 改约束，但它会把新列追加到
 *   `sqlite_master.sql` 的**最后一个列定义之后**（实测：`… DEFAULT 0, source TEXT … DEFAULT 'dsh',`
 *   与最后一行列同行），而 `verifyTable()` 的 SQLite 分支是**按表定义全文比对**的
 *   （normalize 只去掉空白与引号）。拼接位置与 SQLite 的改写不一致 ⇒ 迁移做完却判失败。
 *   本模块的 `portalV9UsageEventStatement()` 因此刻意产出「每个列各占一行」的形态：
 *   空白被 normalize 抹掉，所以与 SQLite 的改写**归一化后逐字相同**，
 *   同时让 `expectedColumns()` 的逐行正则可以取到 `source`（它要求列定义单独成行）。
 *
 * ## 语义
 *
 * - 值域是受控枚举 `SessionSource`（`dsh` / `codex` / `claude-code` / `trae` /
 *   `trae-cn` / `workbuddy`），**刻意不写 DB 级 CHECK**：与本地库 `usage_event.source`
 *   保持一致（那一列也没有 CHECK），校验落在上报路由（按注册表校验并归一化）。
 *   写 CHECK 会引入 MySQL 内联 CHECK 的自动命名，而 `verifyCurrentMysql` 是按
 *   CHECK 表达式文本比对的 —— 那是另一个只有活体 MySQL 才会暴露的坑。
 * - `DEFAULT 'dsh'`：**历史行按事实兜底**。v9 之前的库只收过 DSH 上报
 *   （`report` 只扫 DSH 的会话根），所以老行是 dsh 不是猜测。
 */
import type { PortalBackendKind } from './dialect.js'

/** 列名（迁移器与查询层共用同一份字面量）。 */
export const PORTAL_SOURCE_COLUMN = 'source'

/** 历史行的来源：v9 之前只有 DSH 上报过。 */
export const PORTAL_SOURCE_DEFAULT = 'dsh'

/**
 * 受控定义里这一列的那一行（两种后端只差类型写法）。
 *
 * ⚠️ `VARCHAR(32)` 而不是 `TEXT`：MySQL 的 `TEXT` **不能有 DEFAULT**
 *   （8.0.13 起只有表达式默认值 `DEFAULT ('dsh')`，那又是另一种方言形状）。
 *   32 字节装得下最长的来源 id（`claude-code` / `workbuddy`）。
 */
export function portalSourceColumnLine(kind: PortalBackendKind): string {
  return kind === 'mysql'
    ? `  ${PORTAL_SOURCE_COLUMN} VARCHAR(32) NOT NULL DEFAULT '${PORTAL_SOURCE_DEFAULT}',`
    : `  ${PORTAL_SOURCE_COLUMN} TEXT NOT NULL DEFAULT '${PORTAL_SOURCE_DEFAULT}',`
}

/**
 * 把 v9 的列拼进 `usage_event` 的受控定义（见文件头：插入点是硬约束，不是排版）。
 *
 * 找不到表级约束就抛错：那说明 v5 文本被改过，宁可当场失败也不要拼出一个
 * 「看着像对」的定义 —— 后者会让迁移在真实库上判不符，而原因极难定位。
 */
export function portalV9UsageEventStatement(kind: PortalBackendKind, base: string): string {
  const lines = base.split('\n')
  const constraintAt = lines.findIndex(line => /^ {2}(FOREIGN KEY|CHECK|UNIQUE|PRIMARY KEY)\b/.test(line))
  if (constraintAt <= 0) throw new Error('usage_event 受控定义里找不到表级约束，无法确定 v9 列的插入点')
  const spliced = [...lines]
  spliced.splice(constraintAt, 0, portalSourceColumnLine(kind))
  return spliced.join('\n')
}

/**
 * 迁移 v8→v9 要执行的那一条语句（**幂等由调用方判断列是否已存在**）。
 *
 * 不加 `AFTER`：`received_at_ms` 本来就是最后一列，两种后端默认都追加到末尾，
 * 而受控定义的拼接点也正是末尾 —— 写死 `AFTER` 反而会在列序被改过时报错。
 */
export function portalV9AddColumnStatement(kind: PortalBackendKind): string {
  const line = portalSourceColumnLine(kind).trim().replace(/,$/, '')
  return `ALTER TABLE usage_event ADD COLUMN ${line}`
}

/** v9 的摘要输入（`portalSchemaChecksum` 按它把受控定义的变化算进去）。 */
export function portalV9ChecksumInput(kind: PortalBackendKind): string {
  return portalSourceColumnLine(kind).trim()
}
