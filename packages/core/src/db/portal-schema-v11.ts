/**
 * 上报库 v11 追加：**项目归一化规则表 `project_alias` + 两条权限码**。
 *
 * ## 它解决什么问题
 *
 * 看板的「项目」维度今天取的是 `cwd` 的**最后一段路径**
 * （`D:\Coding_agent\ai-token-report\packages\core` → `core`，见
 * `aggregate.ts` 的 `projectName()`）。这个规则有两个方向都会出错的后果：
 *
 * - **一个项目散成好几行**：仓库根、各子包、`packages/web-local` 各占一行，
 *   于是「这个项目一共用了多少」根本没有地方能看出来；
 * - **不同项目被并成一行**：两个不相干的 `core` 目录共用一个名字。
 *
 * `project_alias` 让使用者把「原始 cwd 前缀」显式映射到一个项目名，
 * 于是「按项目维度统计」第一次有了一个**可配置、可解释**的口径。
 *
 * ## ★ 与 `provider_alias`（v6）同一套纪律
 *
 * 1. **查询时归一化，事件原值一个字节都不改**：规则的载体是这张表，
 *    `usage_event.cwd` 永远是上报当时的原值。改一条规则立刻对历史生效、
 *    随时可以改回去，也不需要任何回填脚本 —— 不违反「迁移前后事件指纹
 *    必须逐位相同」这条硬约束。
 * 2. **未配置的 cwd 保持自身**：没有命中任何规则时仍然回落
 *    `projectName()` 的旧口径（最后一段路径），不是空串、也不是 `other`。
 *    漏配一条规则的后果是「它单独占一行」，不是一个静默的错误名字。
 * 3. **规则逐条覆盖**：人员级规则优先于全局规则（见 `project-alias.ts`）。
 *
 * ## ⚠️ 与 `provider_alias` 的**两处刻意不同**
 *
 * 1. **匹配是前缀，不是精确**。`cwd` 是目录路径，一个项目天然覆盖它下面的
 *    所有子目录；要求使用者为每个子目录各配一条规则，等于让这个功能不可用。
 *    匹配按**路径分隔符边界**判定（`D:\a\proj` 命中 `D:\a\proj\src`，
 *    但**不**命中 `D:\a\proj-other`），且**最长前缀优先**。
 * 2. **没有 SQL 侧的 `CASE`**。项目维度的分组本来就在 JS 侧完成
 *    （`query.ts` 的 `groupRowsFromProject()` —— 目录切分规则只有
 *    `aggregate.ts` 一份实现），所以规则只需要读进内存后逐行套用。
 *    于是这张表**不参与任何 JOIN，也不生成任何 SQL 片段** ——
 *    「JOIN 让事件行复制、`SUM()` 放大」那一类风险在这条路径上根本不存在。
 *
 * ## 为什么不写进 `portal-schema-v5.ts` 的 v6 常量
 *
 * 与 v8 / v9 / v10 同样的理由：v6 / v7 的 DDL 文本**已被冻结**
 * （`portalSchemaChecksumV6/V7/...` 按它们的**当前全文**求摘要），
 * 改一个字就会让那些库从「可迁移的起点」退化成 `unsupported`
 * （服务端拒绝启动、迁移脚本也拒绝接手）。所以这一版独立成文件，
 * 由 `portal-schema-v5.ts` 的 `portalSchemaStatements()` 追加。
 */
import type { PortalBackendKind } from './dialect.js'

/**
 * 原始 cwd 前缀列的长度上限。
 *
 * ★ 512 是**给足**而不是「够用就好」：规则写的是项目根目录，而
 *   「一个仓库放在很深的目录下」是常态（本机实测 `D:\Coding_agent\ai-token-report`
 *   已经 30 字符）。上限取得太小，表现是「这个项目的规则根本建不出来」，
 *   而使用者只会以为页面坏了。
 *
 * ⚠️ 它同时是 MySQL 侧的**索引键长**来源：
 *   `(member_id, prefix)` = 36 字节（ascii CHAR(36)）+ 512×4 字节（utf8mb4）
 *   = 2084 字节 < InnoDB DYNAMIC 行格式的 3072 字节上限。
 *   **把它改大之前必须重算这个加法**，否则唯一索引会在建表时直接
 *   errno 1071（key too long），而 SQLite 上永远测不出来。
 */
export const PROJECT_PREFIX_MAX_LENGTH = 512

/** 归一化后的项目名上限（与 `provider_alias.alias` 的应用层上限一致）。 */
export const PROJECT_ALIAS_MAX_LENGTH = 128

/** 表名（查询层与仓储层都从这里取，避免两处各写一个字面量）。 */
export const PROJECT_ALIAS_TABLE = 'project_alias'

/**
 * SQLite 形态的 v11 追加。
 *
 * ⚠️ 每列**单独成行、两个空格缩进**：`portal-migrations.ts` 的
 *   `expectedColumns()` 用逐行正则读受控定义，排版不对会让「逐列核对」
 *   读到零列，于是校验变成「没有一列不符」——一个永远通过的校验。
 */
export const PORTAL_SQLITE_V11_ADDITIONS = `
-- ★ v11：项目（cwd 前缀）归一化规则。
-- 规则只在**查询时**生效，usage_event.cwd 永远是上报当时的原值。
-- scope='global' 时 member_id 必须为 NULL；scope='member' 时必须指向一个人员。
-- ★ 匹配是**前缀**（按路径分隔符边界），最长前缀优先；未命中时回落
--   projectName() 的旧口径（最后一段路径），不是空串也不是 other。
CREATE TABLE project_alias (
  alias_id TEXT NOT NULL PRIMARY KEY CHECK ((length(alias_id) = 36 AND substr(alias_id,9,1) = '-' AND substr(alias_id,14,1) = '-' AND substr(alias_id,19,1) = '-' AND substr(alias_id,24,1) = '-' AND length(replace(alias_id,'-','')) = 32 AND replace(alias_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global','member')),
  member_id TEXT NULL CHECK (member_id IS NULL OR (length(member_id) = 36 AND substr(member_id,9,1) = '-' AND substr(member_id,14,1) = '-' AND substr(member_id,19,1) = '-' AND substr(member_id,24,1) = '-' AND length(replace(member_id,'-','')) = 32 AND replace(member_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  prefix TEXT NOT NULL CHECK (length(prefix) BETWEEN 1 AND 512),
  alias TEXT NOT NULL CHECK (length(alias) BETWEEN 1 AND 255),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at_ms INTEGER NOT NULL CHECK ((typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991)),
  updated_at_ms INTEGER NOT NULL CHECK ((typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991)),
  CHECK ((scope = 'global' AND member_id IS NULL) OR (scope = 'member' AND member_id IS NOT NULL)),
  CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
-- ⚠️ 唯一索引**两个后端逐字相同**（不用 SQLite 的部分索引）：理由与 v6 的
--   provider_alias 完全相同 —— MySQL 没有「CREATE UNIQUE INDEX ... WHERE」，
--   两套唯一约束会让 verifyUniqueConstraints 判「迁移做完了却不算成功」。
-- ⚠️ 与 provider_alias 同一个已知缺口：两端的唯一索引都不拦含 NULL 的行，
--   所以「同一前缀只有一条**全局**规则」**不由数据库保证**，
--   只有 repository.ts 的 findProjectAlias() 显式查重兜住。
CREATE UNIQUE INDEX idx_project_alias_member ON project_alias (member_id, prefix);
CREATE INDEX idx_project_alias_prefix ON project_alias (prefix);
CREATE INDEX idx_project_alias_scope ON project_alias (scope, enabled);
`

/** MySQL 形态的 v11 追加（与 SQLite 侧**逐列同名同类型**，只差方言）。 */
export const PORTAL_MYSQL_V11_ADDITIONS = `
-- ★ v11：项目（cwd 前缀）归一化规则。
-- 规则只在**查询时**生效，usage_event.cwd 永远是上报当时的原值。
-- scope='global' 时 member_id 必须为 NULL；scope='member' 时必须指向一个人员。
-- ★ 匹配是**前缀**（按路径分隔符边界），最长前缀优先；未命中时回落
--   projectName() 的旧口径（最后一段路径），不是空串也不是 other。
CREATE TABLE project_alias (
  alias_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (alias_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  scope VARCHAR(16) NOT NULL DEFAULT 'global' CHECK (scope IN ('global','member')),
  member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL CHECK (member_id IS NULL OR member_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  prefix VARCHAR(512) NOT NULL CHECK (CHAR_LENGTH(prefix) BETWEEN 1 AND 512),
  alias VARCHAR(255) NOT NULL CHECK (CHAR_LENGTH(alias) BETWEEN 1 AND 255),
  enabled TINYINT NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at_ms BIGINT NOT NULL CHECK ((created_at_ms BETWEEN 0 AND 9007199254740991)),
  updated_at_ms BIGINT NOT NULL CHECK ((updated_at_ms BETWEEN 0 AND 9007199254740991)),
  CHECK ((scope = 'global' AND member_id IS NULL) OR (scope = 'member' AND member_id IS NOT NULL)),
  CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
-- ⚠️ 这个唯一索引的键长 = 36（ascii CHAR(36)）+ 512×4（utf8mb4 VARCHAR(512)）
--   = 2084 字节，只在 InnoDB 的 DYNAMIC 行格式（MySQL 8 默认，上限 3072）下合法。
--   把 prefix 加长之前必须重算，否则 errno 1071。
CREATE UNIQUE INDEX idx_project_alias_member ON project_alias (member_id, prefix);
CREATE INDEX idx_project_alias_prefix ON project_alias (prefix);
CREATE INDEX idx_project_alias_scope ON project_alias (scope, enabled);
`

/**
 * 权限码 `projects:read` / `projects:manage`。
 *
 * UUID 续在 `pricing:manage`（`…115`）之后，用 `…116` / `…117`。
 * 幂等写法与理由同 v6 / v7（MySQL 的 DDL 会隐式提交，迁移崩过一次就会重跑；
 * 裸 `INSERT` 会让 resume 直接撞主键）。
 *
 * ★ 与 `providers:*` 完全同款：**只授予内置管理员角色**（`…0001`）。
 *   项目口径对**全平台**的统计口径都有影响，普通成员不该能改它。
 *   需要放开时在角色页显式授予，而不是塞进基础角色 ——
 *   默认可见/可改的全局口径改不回「不可改」。
 *
 * ⚠️ **读也要一道独立的门**（`projects:read`），不复用 `stats:read`：
 *   规则目录是**配置**（谁把哪个目录算成了哪个项目），而看板本身不读管理接口
 *   —— 它走 `stats:read` 的 `loadProjectAliases()`。所以「能看数据」与
 *   「能看规则目录」是两件事（与 provider 同一取舍）。
 */
export const PORTAL_V11_PERMISSION_SQL = [
  "INSERT INTO permissions (permission_id,code,description,created_at_ms) SELECT '00000000-0000-4000-8000-000000000116','projects:read','projects:read',0 WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE permission_id='00000000-0000-4000-8000-000000000116')",
  "INSERT INTO permissions (permission_id,code,description,created_at_ms) SELECT '00000000-0000-4000-8000-000000000117','projects:manage','projects:manage',0 WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE permission_id='00000000-0000-4000-8000-000000000117')",
  "INSERT INTO role_permissions (role_id,permission_id) SELECT '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000116' WHERE NOT EXISTS (SELECT 1 FROM role_permissions WHERE role_id='00000000-0000-4000-8000-000000000001' AND permission_id='00000000-0000-4000-8000-000000000116')",
  "INSERT INTO role_permissions (role_id,permission_id) SELECT '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000117' WHERE NOT EXISTS (SELECT 1 FROM role_permissions WHERE role_id='00000000-0000-4000-8000-000000000001' AND permission_id='00000000-0000-4000-8000-000000000117')",
]

/** 某后端上「v11 追加」的完整语句清单（建表 + 建索引 + 权限行）。 */
export function portalV11Statements(kind: PortalBackendKind): string[] {
  const additions = kind === 'mysql' ? PORTAL_MYSQL_V11_ADDITIONS : PORTAL_SQLITE_V11_ADDITIONS
  return [...additions.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean), ...PORTAL_V11_PERMISSION_SQL]
}

/** 某后端上 v11 追加里的**表定义**（供迁移器逐列核对）。 */
export function portalV11TableStatement(kind: PortalBackendKind, table: string): string {
  const sql = portalV11Statements(kind).find(statement => statement.startsWith(`CREATE TABLE ${table} (`))
  if (!sql) throw new Error(`缺少 v11 受控表定义：${table}`)
  return sql
}

/** v11 的摘要输入（`portalSchemaChecksum` 按它把受控定义的变化算进去）。 */
export function portalV11ChecksumInput(kind: PortalBackendKind): string {
  return kind === 'mysql' ? PORTAL_MYSQL_V11_ADDITIONS : PORTAL_SQLITE_V11_ADDITIONS
}
