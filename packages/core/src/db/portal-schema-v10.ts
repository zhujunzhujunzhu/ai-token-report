/**
 * 上报库 v10 追加：**给 `model_price` 补五列闲时（低谷）价**。
 *
 * ## 为什么与 v9 同一形状（动的是既有表，而不是加表）
 *
 * `offpeak_schedule` + 四类闲时单价要挂在**已有的价行**上，而不是新建一张表：
 * 闲时价与高峰价是**同一份价格协议的两档**（同币种、同生效区间、同一条备注），
 * 拆成两张表就会出现「一半的价行有这个字段、另一半没有」这种表达不出来的状态。
 * 而 v5 的 DDL 文本一个字都不许改（`portalSchemaChecksumV6/V7/V8` 按它们的
 * **当前全文**求摘要，改了会让那些库从「可迁移的起点」退化成 `unsupported`），
 * 所以这一版照抄 v9 的做法：**不写进 v7 常量，而是在受控定义里拼接**。
 *
 * ## 语义
 *
 * | 列 | 含义 |
 * |---|---|
 * | `offpeak_schedule` | 闲时时段表 id（`shared/price.ts` 的 `PRICE_SCHEDULES`），如 `deepseek-cn` |
 * | `offpeak_input_micro_per_ktok` … | 闲时档的四类单价，单位与主价一致（整数微元 / 千 token） |
 *
 * 🚨 **两组字段同生共死**：要么五个全 `NULL`（这条价不分时段），
 * 要么时段表 + 四个价齐全。半个闲时档（例如只填两个价）会让缺的那两档按 **0 元**算
 * —— 而 0 是合法单价，`costMicroForTokens()` 不会报错，费用只是静默偏低。
 * 这条约束由写入路径（`shared/price.ts` 的 `offpeakConfigError()`）兜住，
 * **刻意不写进 DB 级 CHECK**：五列之间的联动 CHECK 在 SQLite 上无法 `ALTER` 追加
 * （那要重建整张表），而两种后端写同一个 CHECK 又是另一处必然漂移的实现。
 *
 * ⚠️ 五个新列都可空、都没有默认值：v9 及更早的价行读出来就是「不分时段」，
 * 与它们当年被写入时的语义**逐字一致**（历史金额不会因为这次迁移而变）。
 */
import type { PortalBackendKind } from './dialect.js'

/**
 * 闲时时段表 id 列。
 *
 * ⚠️ `VARCHAR(64)` 而不是 `TEXT`：两个后端都要能加列，而 MySQL 的 `TEXT`
 *   在 `ADD COLUMN` 上虽然合法，但与 `expectedColumns()` 的「逐列同名同类型」
 *   核对口径无关 —— 这里选 VARCHAR 只是与 `usage_event.source` 同一个理由：
 *   `TEXT` 不能有 DEFAULT，将来若要加默认值就得再来一次迁移。
 */
export const PORTAL_OFFPEAK_SCHEDULE_COLUMN = 'offpeak_schedule'

/** 四类闲时单价列（顺序 = 计价公式里的顺序，便于人工核对）。 */
export const PORTAL_OFFPEAK_RATE_COLUMNS = [
  'offpeak_input_micro_per_ktok',
  'offpeak_output_micro_per_ktok',
  'offpeak_cache_read_micro_per_ktok',
  'offpeak_cache_write_micro_per_ktok',
] as const

/** 单价上限，与 `shared/price.ts` 的 `MAX_MICRO_PER_KTOK` 和 v7 的 CHECK **同一个数**。 */
const MAX_MICRO_PER_KTOK = 10_000_000

/**
 * 五列在受控定义里的文本（两种后端只差类型与 `length` 函数名）。
 *
 * 每列**单独成行**：与 v9 同样的理由 —— `expectedColumns()` 的逐行正则要求
 * 列定义单独成行，而 SQLite 的 `ALTER TABLE ADD COLUMN` 改写 `sqlite_master.sql` 后
 * 与这里的文本**归一化（抹空白与引号）后逐字相同**。
 */
export function portalV10ModelPriceColumnLines(kind: PortalBackendKind): string[] {
  const schedule = kind === 'mysql'
    ? `  ${PORTAL_OFFPEAK_SCHEDULE_COLUMN} VARCHAR(64) NULL CHECK (${PORTAL_OFFPEAK_SCHEDULE_COLUMN} IS NULL OR CHAR_LENGTH(${PORTAL_OFFPEAK_SCHEDULE_COLUMN}) BETWEEN 1 AND 64),`
    : `  ${PORTAL_OFFPEAK_SCHEDULE_COLUMN} TEXT NULL CHECK (${PORTAL_OFFPEAK_SCHEDULE_COLUMN} IS NULL OR length(${PORTAL_OFFPEAK_SCHEDULE_COLUMN}) BETWEEN 1 AND 64),`
  const rates = PORTAL_OFFPEAK_RATE_COLUMNS.map((column) => kind === 'mysql'
    ? `  ${column} INT NULL CHECK (${column} IS NULL OR ${column} BETWEEN 0 AND ${MAX_MICRO_PER_KTOK}),`
    : `  ${column} INTEGER NULL CHECK (${column} IS NULL OR (typeof(${column}) = 'integer' AND ${column} BETWEEN 0 AND ${MAX_MICRO_PER_KTOK})),`)
  return [schedule, ...rates]
}

/**
 * 把 v10 的五列拼进 `model_price` 的受控定义。
 *
 * 🚨 插入点是**被 SQLite 的改写规则钉住的**，不是排版偏好：`ADD COLUMN` 会把新列
 * 追加到**最后一个列定义之后、第一条表级约束之前**，而 `verifyTable()` 在 SQLite
 * 分支按表定义全文比对（只抹空白与引号）。位置不一致 ⇒ 迁移做完了却判失败。
 *
 * 找不到表级约束就抛错：那说明 v7 文本被改过，宁可当场失败也不要拼出一个
 * 「看着像对」的定义。
 */
export function portalV10ModelPriceStatement(kind: PortalBackendKind, base: string): string {
  const lines = base.split('\n')
  const constraintAt = lines.findIndex(line => /^ {2}(FOREIGN KEY|CHECK|UNIQUE|PRIMARY KEY)\b/.test(line))
  if (constraintAt <= 0) throw new Error('model_price 受控定义里找不到表级约束，无法确定 v10 列的插入点')
  const spliced = [...lines]
  spliced.splice(constraintAt, 0, ...portalV10ModelPriceColumnLines(kind))
  return spliced.join('\n')
}

/**
 * 迁移 v9→v10 要执行的语句（**幂等由调用方判断列是否已存在**）。
 *
 * 一条一列：`ALTER TABLE` 一次加一列，失败时能明确停在**哪一列**上
 * （MySQL 的 DDL 隐式提交，一次加五列的语句中途失败会留下半套列）。
 */
export function portalV10AddColumnStatements(kind: PortalBackendKind): string[] {
  return portalV10ModelPriceColumnLines(kind).map((line) => `ALTER TABLE model_price ADD COLUMN ${line.trim().replace(/,$/, '')}`)
}

/** v10 的摘要输入（`portalSchemaChecksum` 按它把受控定义的变化算进去）。 */
export function portalV10ChecksumInput(kind: PortalBackendKind): string {
  return portalV10ModelPriceColumnLines(kind).map(line => line.trim()).join('\n')
}
