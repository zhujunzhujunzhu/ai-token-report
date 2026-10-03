/**
 * 上报库 v12 追加：**给 `provider_alias` 补一列 `model`**，规则从「只折叠供应商」
 * 变成「供应商 / 模型都能折叠」（页面上叫「供应商模型归一化」）。
 *
 * ## 一列 `model` 就把两种规则分开了
 *
 * | `model` 值 | 这条规则是干什么的 |
 * |---|---|
 * | `NULL` | **供应商规则**（v6 起的原语义）：匹配 `provider`，把供应商名折叠成 `alias` |
 * | 非 NULL | **模型规则**：匹配 `model`，把模型名折叠成 `alias` |
 *
 * 用「有值 / 无值」区分规则种类，而不是再加一列 `target`：两者是同一件事的两种取值
 * （折叠哪个维度）。多一列只会多出一个必然漂移的字段 —— 一旦写成
 * `target='model'` 而 `model IS NULL`，这条规则就是一条永远不命中的幽灵，
 * 而页面上它看起来完全正常。
 *
 * `provider = '*'`（{@link ANY_PROVIDER}）表示**任意供应商**：模型规则用它表达
 * 「不管这条用量是哪家报的，模型名 `qwen-max` 都记成 `通义千问-Max`」。
 * 供应商列在 v6 就是 `NOT NULL`，而 SQLite 不支持 `ALTER TABLE` 去约束
 * （那要重建整张表），所以「不限定供应商」只能写一个哨兵值 ——
 * 选 `*` 是因为它**不可能是一个真实供应商名**（`providerNameError()` 的字符集里没有它）。
 *
 * ## 🚨 唯一索引必须从 `(member_id, provider)` 换成 `(member_id, provider, model)`
 *
 * 不换就会出一件静默的坏事：「`dashscope` 这条供应商规则」与「`dashscope` +
 * `qwen-max` 这条模型规则」在旧索引下是**同一个键**，第二条根本写不进去
 * （MySQL 直接唯一冲突，SQLite 侧由应用层查重挡住）—— 而这两条规则明明是
 * 使用者会同时配置的两件事。
 *
 * ### MySQL 上换索引必须走「临时名」三步，不能先 DROP
 *
 * `provider_alias.member_id` 上有指向 `members` 的外键，而 **InnoDB 要求外键列上
 * 存在一个以它为最左前缀的索引**。当前唯一覆盖 `member_id` 最左前缀的恰恰就是
 * `idx_provider_alias_member` —— 先 `DROP` 它会被 errno 1553
 * （`Cannot drop index …: needed in a foreign key constraint`）当场挡住。
 *
 * 所以 MySQL 侧的顺序是：以临时名建出覆盖同一最左前缀的新索引 → 删旧索引
 * （此时外键已有索引可用）→ 把临时名改回受控索引名。SQLite 没有这条联动，
 * 直接 `DROP INDEX` + `CREATE UNIQUE INDEX` 即可。
 * 两个后端的**终态**是同一个索引名 + 同一组列，所以受控定义只需声明一份。
 *
 * ## 与 v12 之前的受控定义文本的关系
 *
 * `portal_alias` 那张表来自 v6 的追加常量，而 **v6 的文本一个字都不许再改**：
 * `portalSchemaChecksumV6/V7/V8/V9/V10/V11` 是按它们的**当前全文**求摘要的，
 * 改一个字就会让已经迁到那些版本的库（包括线上库）从「可迁移的起点」退化成
 * `unsupported`（服务端拒绝启动）。所以这一列与换索引都由本模块**拼接**进
 * 生效的受控定义，并由 v10→v11→v12 的迁移步骤落到既有库上。
 *
 * ⚠️ v11 的 `project_alias` 与本模块无关，但两者**同在一条迁移链上**：
 *   v11 是纯追加，v12 需要 `provider_alias` 已经存在（v6 起就在了）。
 */
import type { PortalBackendKind } from './dialect.js'
// ★ 哨兵值**不在这里另起一个字面量**：它与模型单价的「不限供应商基础价」
//   （`shared/price.ts` 的 `ANY_PROVIDER`）是同一个 `'*'`。两处各写一遍，
//   改错一处不会报错，只会让模型规则永远不命中。
import { ANY_PROVIDER } from '@ai-token-report/shared'

/** 新列名（迁移器、查询层与校验共用同一份字面量）。 */
export const PORTAL_MODEL_COLUMN = 'model'

/**
 * 「任意供应商」哨兵值（模型规则专用），DDL 侧的名字。
 *
 * ⚠️ 它只是 `shared/price.ts` 的 `ANY_PROVIDER` 的**别名**，不是第二个字面量 ——
 *   校验用的 `providerNameError()` 不接受 `*`，所以它不可能与真实供应商名相撞。
 */
export const PORTAL_ANY_PROVIDER = ANY_PROVIDER

/** 受控唯一索引名（v6 起的名字，**刻意不改**：改名等于让两个后端各有一套索引名）。 */
export const PORTAL_PROVIDER_ALIAS_UNIQUE_INDEX = 'idx_provider_alias_member'

/**
 * MySQL 换索引时的临时索引名。
 *
 * 只在迁移的一瞬间存在。带版本后缀是为了在「建好临时索引、还没来得及删旧索引」
 * 时进程被杀掉之后，resume 能一眼认出这是自己留下的中间态。
 */
export const PORTAL_PROVIDER_ALIAS_TEMP_INDEX = 'idx_provider_alias_member_v12'

/** 唯一索引的列组合（受控定义、迁移与校验三处共用，避免任何一处写少一列）。 */
export const PORTAL_PROVIDER_ALIAS_UNIQUE_COLUMNS = 'member_id, provider, model'

/** `model` 列的长度上限（与 `provider` / `alias` 同为 255，两种后端同值）。 */
export const PORTAL_MODEL_MAX_LENGTH = 255

/**
 * 受控定义里 `model` 那一列的那一行（两种后端只差类型与 `length` 函数名）。
 *
 * ⚠️ 可空、**无默认值**：`NULL` 的含义是「这是一条供应商规则」，
 *   与 v6 起的既有行语义**逐字一致** —— 老行的 `model` 读出来就是供应商规则，
 *   不需要任何回填，也不违反「迁移前后事件指纹必须逐位相同」。
 */
export function portalModelColumnLine(kind: PortalBackendKind): string {
  return kind === 'mysql'
    ? `  ${PORTAL_MODEL_COLUMN} VARCHAR(${PORTAL_MODEL_MAX_LENGTH}) NULL CHECK (${PORTAL_MODEL_COLUMN} IS NULL OR CHAR_LENGTH(${PORTAL_MODEL_COLUMN}) BETWEEN 1 AND ${PORTAL_MODEL_MAX_LENGTH}),`
    : `  ${PORTAL_MODEL_COLUMN} TEXT NULL CHECK (${PORTAL_MODEL_COLUMN} IS NULL OR length(${PORTAL_MODEL_COLUMN}) BETWEEN 1 AND ${PORTAL_MODEL_MAX_LENGTH}),`
}

/**
 * 把 `model` 列拼进 `provider_alias` 的受控定义。
 *
 * 🚨 插入点是**被 SQLite 的改写规则钉住的**，不是排版偏好：`ADD COLUMN` 会把新列
 * 追加到**最后一个列定义之后、第一条表级约束之前**，而 `verifyTable()` 的 SQLite 分支
 * 是按表定义全文比对的（只抹空白与引号）。位置不一致 ⇒ 迁移做完了却判失败。
 *
 * 找不到表级约束就抛错：那说明 v6 的文本被改过，宁可当场失败也不要拼出一个
 * 「看着像对」的定义 —— 后者会让迁移在真实库上判不符，而原因极难定位。
 */
export function portalV12ProviderAliasStatement(kind: PortalBackendKind, base: string): string {
  const lines = base.split('\n')
  const constraintAt = lines.findIndex(line => /^ {2}(FOREIGN KEY|CHECK|UNIQUE|PRIMARY KEY)\b/.test(line))
  if (constraintAt <= 0) throw new Error('provider_alias 受控定义里找不到表级约束，无法确定 v12 列的插入点')
  const spliced = [...lines]
  spliced.splice(constraintAt, 0, portalModelColumnLine(kind))
  return spliced.join('\n')
}

/**
 * 迁移 v11→v12 要执行的加列语句（**幂等由调用方判断列是否已存在**）。
 *
 * 不加 `AFTER`：两种后端默认都追加到末尾，而受控定义的拼接点也正是末尾 ——
 * 写死 `AFTER` 反而会在列序被改过时报错（与 `portalV9AddColumnStatement` 同款）。
 */
export function portalV12AddColumnStatement(kind: PortalBackendKind): string {
  const line = portalModelColumnLine(kind).trim().replace(/,$/, '')
  return `ALTER TABLE provider_alias ADD COLUMN ${line}`
}

/** 终态的受控唯一索引语句（两种后端**逐字相同**：只有索引名与列，没有方言差异）。 */
export function portalProviderAliasUniqueIndex(): string {
  return `CREATE UNIQUE INDEX ${PORTAL_PROVIDER_ALIAS_UNIQUE_INDEX} ON provider_alias (${PORTAL_PROVIDER_ALIAS_UNIQUE_COLUMNS})`
}

/**
 * MySQL 换索引第一步用的**临时索引**语句（只在这个迁移的一瞬间存在）。
 *
 * ⚠️ 它与终态索引**列完全相同**，只差名字 —— 这不是多余的一步：
 *   先删旧索引会被外键挡住（见文件头），所以必须先有一个覆盖同一最左前缀的
 *   新索引顶上，旧索引才能删掉。
 */
export function portalProviderAliasTemporaryIndex(): string {
  return `CREATE UNIQUE INDEX ${PORTAL_PROVIDER_ALIAS_TEMP_INDEX} ON provider_alias (${PORTAL_PROVIDER_ALIAS_UNIQUE_COLUMNS})`
}

/**
 * 把语句清单里的旧唯一索引替换成 v12 的终态定义。
 *
 * ★ `portalSchemaStatements()` 与 `upgradeV5ToV6()` 都必须用它 —— 两处看到的
 *   **必须是同一份**索引文本，否则「迁移出来的库」与「新建的库」会各有一套索引，
 *   而 SQLite 侧只比表定义、根本看不出来（`idx_provider_alias_member` 当年就这么
 *   漏了两个版本，见 `isCreateIndex()` 的注释）。
 */
export function portalV12ReplaceProviderAliasIndex(statements: readonly string[]): string[] {
  const replacement = portalProviderAliasUniqueIndex()
  return statements.map(sql =>
    /^CREATE UNIQUE INDEX idx_provider_alias_member ON provider_alias \(/.test(sql) ? replacement : sql)
}

/** v12 的摘要输入（`portalSchemaChecksum` 按它把受控定义的变化算进去）。 */
export function portalV12ChecksumInput(kind: PortalBackendKind): string {
  return `${portalModelColumnLine(kind).trim()}\n${portalProviderAliasUniqueIndex()}`
}
