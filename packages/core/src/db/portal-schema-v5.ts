/**
 * 上报库受控 DDL 的真源（**全新库直接按它建**）。
 *
 * ## 版本关系（读之前先看这一节）
 *
 * | 版本 | 状态 | 说明 |
 * |---|---|---|
 * | v4 | ★ **冻结基线**（`portal-schema-v4.ts`） | v3 库先迁到它，再往上走 |
 * | v5 | 结构改造步骤 | 「分组（多对多）」+ 权限码 `groups:*` |
 * | v6 | 结构追加步骤 | 追加 `provider_alias` 表与权限码 `providers:*` |
 * | v7 | ★ **当前终态** | 追加 `model_price` 表（模型单价）与权限码 `cost:read` / `pricing:manage` |
 *
 * ⚠️ **本文件的 SQL 常量代表 v7 终态**，v5 / v6 的结构变化都是它的一部分：
 *   `PORTAL_SCHEMA_VERSION = 7` + 末尾的 {@link PORTAL_SQLITE_V6_ADDITIONS}
 *   + {@link PORTAL_SQLITE_V7_ADDITIONS}
 *   （追加 `provider_alias`、`model_price` 与权限行）共同构成受控定义。
 *   已经迁到 v6 的库不会被误判为 `current` ——
 *   受控定义的文本摘要变了，旧库会落入 `legacy` 并**必须显式迁移**，
 *   这正是「schema 变更绝不自愈」这条铁律要的行为。
 *
 * ## v5 相对 v4 的三处结构变化
 *
 * 1. `departments` → `member_groups`、`department_id` → `group_id`（术语统一为「分组」）；
 * 2. ★ **人员与分组改为多对多**：`members.department_id` 单值列被删除，
 *    改由 `member_group_assignments` 承载。因此 `usage_event` 也不再持有分组 ID ——
 *    一个事件属于哪个分组，由它的 `member_id` 关联出当前所属的每个分组。
 *    `usage_event.dept`（上报当时的文本快照）改名为 `group_name`。
 * 3. 权限码 `departments:read` / `departments:manage` → `groups:read` / `groups:manage`。
 *
 * ## v6 相对 v5 只有**追加**，不改任何既有列
 *
 * `provider_alias`（供应商归一化规则）+ `providers:read` / `providers:manage`。
 * 🚨 `usage_event` 一个字节都不动 —— 规则是**查询时**应用的，
 *   事件里的 provider 永远是上报当时的原值（见 `provider-alias.ts` 的文件头）。
 *
 * ## v7 相对 v6 同样只有**追加**
 *
 * `model_price`（模型单价，按 `provider` + `model` 精确匹配）+ 权限码
 * `cost:read` / `pricing:manage`。
 *
 * 🚨 **不存任何金额列**：费用永远在查询期用「事件的 4 个 token 数 × 生效单价」
 *   现算（口径在 `@ai-token-report/shared/price.ts`）。把算好的金额落库，
 *   一旦单价被修正（补录历史价、改错价），库里就已经是一份算错的旧账，
 *   而它看起来完全正常。同理，单价带生效区间，所以**改价不改历史**。
 *
 * ⚠️ v4 的 SQL 仍是**冻结基线**，留在 `portal-schema-v4.ts` ——
 *   那份文本一个字都不许再改：迁移账本按文本摘要识别版本，
 *   改了它等于让已完成的 v3→v4 迁移变成「checksum 不符」。
 *   本文件同理：v5 与 v6 的 DDL 一旦随版本发布，就只能靠**新增**版本号演进。
 */
import { createHash } from 'node:crypto'
import type { PortalBackendKind } from './dialect.js'
export const PORTAL_SCHEMA_VERSION = 7
export const PORTAL_SQLITE_V5_SQL = `-- 数据库 v5：分组（多对多）+ 权限码 groups:*。
-- 不执行 ALTER/DROP，不修改本地 usage.sqlite 的 schema v3。
-- 部署前必须另行实现带备份、版本闸门与恢复点的生产迁移。
-- UUID 使用小写标准格式；旧 event_id/session_id/user_id 保持原语义。
-- 所有时间为 epoch 毫秒；所有数值不超过 JavaScript 安全整数上限。
-- token/session/binding 仅存 32 字节摘要的 64 位十六进制串。
-- 验证码答案存 HMAC-SHA256，密钥由部署环境提供，绝不保存四位答案或裸 SHA256。
-- 密码哈希复用带算法/版本/盐的编码；数据库不生成、不存明文密码。
-- 历史引用全部 RESTRICT，不以删除人员/令牌清除历史。
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 0;

CREATE TABLE member_groups (
  group_id TEXT NOT NULL PRIMARY KEY CHECK ((length(group_id) = 36 AND substr(group_id,9,1) = '-' AND substr(group_id,14,1) = '-' AND substr(group_id,19,1) = '-' AND substr(group_id,24,1) = '-' AND length(replace(group_id,'-','')) = 32 AND replace(group_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK ((typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991)),
  created_at_ms INTEGER NOT NULL CHECK ((typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991)),
  updated_at_ms INTEGER NOT NULL CHECK ((typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991)),
  UNIQUE (name),
  CHECK (updated_at_ms >= created_at_ms)
);

CREATE TABLE members (
  member_id TEXT NOT NULL PRIMARY KEY CHECK ((length(member_id) = 36 AND substr(member_id,9,1) = '-' AND substr(member_id,14,1) = '-' AND substr(member_id,19,1) = '-' AND substr(member_id,24,1) = '-' AND length(replace(member_id,'-','')) = 32 AND replace(member_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 32),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK ((typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991)),
  created_at_ms INTEGER NOT NULL CHECK ((typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991)),
  updated_at_ms INTEGER NOT NULL CHECK ((typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991)),
  CHECK (updated_at_ms >= created_at_ms)
);
CREATE INDEX idx_members_status ON members (status);

-- ★ 人员与分组是**多对多**：一个人可以同时属于多个分组。
-- 用独立关联表而不是 members 上的 JSON 数组 —— 按分组筛用量要能走索引，
-- 而 JSON 数组会让它退化成全表扫描加 JS 侧解析。
CREATE TABLE member_group_assignments (
  member_id TEXT NOT NULL CHECK ((length(member_id) = 36 AND substr(member_id,9,1) = '-' AND substr(member_id,14,1) = '-' AND substr(member_id,19,1) = '-' AND substr(member_id,24,1) = '-' AND length(replace(member_id,'-','')) = 32 AND replace(member_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  group_id TEXT NOT NULL CHECK ((length(group_id) = 36 AND substr(group_id,9,1) = '-' AND substr(group_id,14,1) = '-' AND substr(group_id,19,1) = '-' AND substr(group_id,24,1) = '-' AND length(replace(group_id,'-','')) = 32 AND replace(group_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  created_at_ms INTEGER NOT NULL CHECK ((typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991)),
  PRIMARY KEY (member_id,group_id),
  FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (group_id) REFERENCES member_groups(group_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_member_group_assignments_group ON member_group_assignments (group_id);

CREATE TABLE roles (
  role_id TEXT NOT NULL PRIMARY KEY CHECK ((length(role_id) = 36 AND substr(role_id,9,1) = '-' AND substr(role_id,14,1) = '-' AND substr(role_id,19,1) = '-' AND substr(role_id,24,1) = '-' AND length(replace(role_id,'-','')) = 32 AND replace(role_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0,1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK ((typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991)),
  created_at_ms INTEGER NOT NULL CHECK ((typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991)),
  updated_at_ms INTEGER NOT NULL CHECK ((typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991)),
  UNIQUE (code),
  CHECK (updated_at_ms >= created_at_ms)
);

CREATE TABLE permissions (
  permission_id TEXT NOT NULL PRIMARY KEY CHECK ((length(permission_id) = 36 AND substr(permission_id,9,1) = '-' AND substr(permission_id,14,1) = '-' AND substr(permission_id,19,1) = '-' AND substr(permission_id,24,1) = '-' AND length(replace(permission_id,'-','')) = 32 AND replace(permission_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 255),
  created_at_ms INTEGER NOT NULL CHECK ((typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991)),
  UNIQUE (code)
);

CREATE TABLE member_roles (
  member_id TEXT NOT NULL CHECK ((length(member_id) = 36 AND substr(member_id,9,1) = '-' AND substr(member_id,14,1) = '-' AND substr(member_id,19,1) = '-' AND substr(member_id,24,1) = '-' AND length(replace(member_id,'-','')) = 32 AND replace(member_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  role_id TEXT NOT NULL CHECK ((length(role_id) = 36 AND substr(role_id,9,1) = '-' AND substr(role_id,14,1) = '-' AND substr(role_id,19,1) = '-' AND substr(role_id,24,1) = '-' AND length(replace(role_id,'-','')) = 32 AND replace(role_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  granted_at_ms INTEGER NOT NULL CHECK ((typeof(granted_at_ms) = 'integer' AND granted_at_ms BETWEEN 0 AND 9007199254740991)),
  PRIMARY KEY (member_id,role_id),
  FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (role_id) REFERENCES roles(role_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_member_roles_role ON member_roles (role_id);

CREATE TABLE role_permissions (
  role_id TEXT NOT NULL CHECK ((length(role_id) = 36 AND substr(role_id,9,1) = '-' AND substr(role_id,14,1) = '-' AND substr(role_id,19,1) = '-' AND substr(role_id,24,1) = '-' AND length(replace(role_id,'-','')) = 32 AND replace(role_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  permission_id TEXT NOT NULL CHECK ((length(permission_id) = 36 AND substr(permission_id,9,1) = '-' AND substr(permission_id,14,1) = '-' AND substr(permission_id,19,1) = '-' AND substr(permission_id,24,1) = '-' AND length(replace(permission_id,'-','')) = 32 AND replace(permission_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  PRIMARY KEY (role_id,permission_id),
  FOREIGN KEY (role_id) REFERENCES roles(role_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (permission_id) REFERENCES permissions(permission_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_role_permissions_permission ON role_permissions (permission_id);

CREATE TABLE login_accounts (
  account_id TEXT NOT NULL PRIMARY KEY CHECK ((length(account_id) = 36 AND substr(account_id,9,1) = '-' AND substr(account_id,14,1) = '-' AND substr(account_id,19,1) = '-' AND substr(account_id,24,1) = '-' AND length(replace(account_id,'-','')) = 32 AND replace(account_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  member_id TEXT NOT NULL CHECK ((length(member_id) = 36 AND substr(member_id,9,1) = '-' AND substr(member_id,14,1) = '-' AND substr(member_id,19,1) = '-' AND substr(member_id,24,1) = '-' AND length(replace(member_id,'-','')) = 32 AND replace(member_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  username_normalized TEXT NOT NULL CHECK (length(username_normalized) BETWEEN 1 AND 64),
  password_hash TEXT NOT NULL CHECK (length(password_hash) BETWEEN 1 AND 512),
  password_version INTEGER NOT NULL DEFAULT 1 CHECK ((typeof(password_version) = 'integer' AND password_version BETWEEN 1 AND 9007199254740991)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK ((typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991)),
  created_at_ms INTEGER NOT NULL CHECK ((typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991)),
  updated_at_ms INTEGER NOT NULL CHECK ((typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991)),
  UNIQUE (member_id),
  UNIQUE (username_normalized),
  CHECK (length(username_normalized) BETWEEN 3 AND 64 AND substr(username_normalized,1,1) GLOB '[a-z0-9]' AND username_normalized NOT GLOB '*[^a-z0-9_.-]*'),
  CHECK (password_hash LIKE '$atr-scrypt$1$%' AND length(password_hash) = 111),
  CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_login_accounts_enabled ON login_accounts (enabled);

CREATE TABLE report_tokens (
  token_id TEXT NOT NULL PRIMARY KEY CHECK ((length(token_id) = 36 AND substr(token_id,9,1) = '-' AND substr(token_id,14,1) = '-' AND substr(token_id,19,1) = '-' AND substr(token_id,24,1) = '-' AND length(replace(token_id,'-','')) = 32 AND replace(token_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  member_id TEXT NOT NULL CHECK ((length(member_id) = 36 AND substr(member_id,9,1) = '-' AND substr(member_id,14,1) = '-' AND substr(member_id,19,1) = '-' AND substr(member_id,24,1) = '-' AND length(replace(member_id,'-','')) = 32 AND replace(member_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  token_hash TEXT NOT NULL CHECK ((length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*')),
  token_prefix TEXT NOT NULL CHECK (length(token_prefix) BETWEEN 1 AND 24),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 128),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK ((typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991)),
  created_at_ms INTEGER NOT NULL CHECK ((typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991)),
  expires_at_ms INTEGER NULL CHECK (expires_at_ms IS NULL OR (typeof(expires_at_ms) = 'integer' AND expires_at_ms BETWEEN 0 AND 9007199254740991)),
  revoked_at_ms INTEGER NULL CHECK (revoked_at_ms IS NULL OR (typeof(revoked_at_ms) = 'integer' AND revoked_at_ms BETWEEN 0 AND 9007199254740991)),
  UNIQUE (token_hash),
  UNIQUE (member_id,token_id),
  CHECK (expires_at_ms IS NULL OR expires_at_ms > created_at_ms),
  CHECK ((status = 'active' AND revoked_at_ms IS NULL) OR (status = 'revoked' AND revoked_at_ms IS NOT NULL AND revoked_at_ms >= created_at_ms)),
  FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_report_tokens_member ON report_tokens (member_id);
CREATE INDEX idx_report_tokens_expires ON report_tokens (expires_at_ms);

CREATE TABLE report_token_scopes (
  token_id TEXT NOT NULL CHECK ((length(token_id) = 36 AND substr(token_id,9,1) = '-' AND substr(token_id,14,1) = '-' AND substr(token_id,19,1) = '-' AND substr(token_id,24,1) = '-' AND length(replace(token_id,'-','')) = 32 AND replace(token_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  permission_id TEXT NOT NULL CHECK ((length(permission_id) = 36 AND substr(permission_id,9,1) = '-' AND substr(permission_id,14,1) = '-' AND substr(permission_id,19,1) = '-' AND substr(permission_id,24,1) = '-' AND length(replace(permission_id,'-','')) = 32 AND replace(permission_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  PRIMARY KEY (token_id,permission_id),
  FOREIGN KEY (token_id) REFERENCES report_tokens(token_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (permission_id) REFERENCES permissions(permission_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_report_token_scopes_permission ON report_token_scopes (permission_id);

CREATE TABLE auth_sessions (
  session_id TEXT NOT NULL PRIMARY KEY CHECK ((length(session_id) = 36 AND substr(session_id,9,1) = '-' AND substr(session_id,14,1) = '-' AND substr(session_id,19,1) = '-' AND substr(session_id,24,1) = '-' AND length(replace(session_id,'-','')) = 32 AND replace(session_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  session_hash TEXT NOT NULL CHECK ((length(session_hash) = 64 AND session_hash NOT GLOB '*[^0-9a-f]*')),
  account_id TEXT NOT NULL CHECK ((length(account_id) = 36 AND substr(account_id,9,1) = '-' AND substr(account_id,14,1) = '-' AND substr(account_id,19,1) = '-' AND substr(account_id,24,1) = '-' AND length(replace(account_id,'-','')) = 32 AND replace(account_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  password_version INTEGER NOT NULL CHECK ((typeof(password_version) = 'integer' AND password_version BETWEEN 1 AND 9007199254740991)),
  created_at_ms INTEGER NOT NULL CHECK ((typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991)),
  expires_at_ms INTEGER NOT NULL CHECK ((typeof(expires_at_ms) = 'integer' AND expires_at_ms BETWEEN 0 AND 9007199254740991)),
  last_seen_at_ms INTEGER NOT NULL CHECK ((typeof(last_seen_at_ms) = 'integer' AND last_seen_at_ms BETWEEN 0 AND 9007199254740991)),
  revoked_at_ms INTEGER NULL CHECK (revoked_at_ms IS NULL OR (typeof(revoked_at_ms) = 'integer' AND revoked_at_ms BETWEEN 0 AND 9007199254740991)),
  UNIQUE (session_hash),
  CHECK (expires_at_ms > created_at_ms),
  CHECK (last_seen_at_ms >= created_at_ms),
  CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms),
  FOREIGN KEY (account_id) REFERENCES login_accounts(account_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_auth_sessions_account ON auth_sessions (account_id);
CREATE INDEX idx_auth_sessions_expires ON auth_sessions (expires_at_ms);

CREATE TABLE auth_challenges (
  challenge_id TEXT NOT NULL PRIMARY KEY CHECK ((length(challenge_id) = 36 AND substr(challenge_id,9,1) = '-' AND substr(challenge_id,14,1) = '-' AND substr(challenge_id,19,1) = '-' AND substr(challenge_id,24,1) = '-' AND length(replace(challenge_id,'-','')) = 32 AND replace(challenge_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  challenge_hash TEXT NOT NULL CHECK ((length(challenge_hash) = 64 AND challenge_hash NOT GLOB '*[^0-9a-f]*')),
  binding_hash TEXT NOT NULL CHECK ((length(binding_hash) = 64 AND binding_hash NOT GLOB '*[^0-9a-f]*')),
  answer_hmac TEXT NOT NULL CHECK ((length(answer_hmac) = 64 AND answer_hmac NOT GLOB '*[^0-9a-f]*')),
  hmac_key_id TEXT NOT NULL CHECK (length(hmac_key_id) BETWEEN 1 AND 64),
  created_at_ms INTEGER NOT NULL CHECK ((typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991)),
  expires_at_ms INTEGER NOT NULL CHECK ((typeof(expires_at_ms) = 'integer' AND expires_at_ms BETWEEN 0 AND 9007199254740991)),
  consumed_at_ms INTEGER NULL CHECK (consumed_at_ms IS NULL OR (typeof(consumed_at_ms) = 'integer' AND consumed_at_ms BETWEEN 0 AND 9007199254740991)),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK ((typeof(attempt_count) = 'integer' AND attempt_count BETWEEN 0 AND 9007199254740991)),
  UNIQUE (challenge_hash),
  CHECK (expires_at_ms > created_at_ms),
  CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms)
);
CREATE INDEX idx_auth_challenges_binding ON auth_challenges (binding_hash);
CREATE INDEX idx_auth_challenges_expires ON auth_challenges (expires_at_ms);

CREATE TABLE auth_rate_limit_buckets (
  bucket_id TEXT NOT NULL PRIMARY KEY CHECK ((length(bucket_id) = 36 AND substr(bucket_id,9,1) = '-' AND substr(bucket_id,14,1) = '-' AND substr(bucket_id,19,1) = '-' AND substr(bucket_id,24,1) = '-' AND length(replace(bucket_id,'-','')) = 32 AND replace(bucket_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 64),
  subject_hash TEXT NOT NULL CHECK ((length(subject_hash) = 64 AND subject_hash NOT GLOB '*[^0-9a-f]*')),
  window_started_at_ms INTEGER NOT NULL CHECK ((typeof(window_started_at_ms) = 'integer' AND window_started_at_ms BETWEEN 0 AND 9007199254740991)),
  expires_at_ms INTEGER NOT NULL CHECK ((typeof(expires_at_ms) = 'integer' AND expires_at_ms BETWEEN 0 AND 9007199254740991)),
  used_points INTEGER NOT NULL DEFAULT 0 CHECK ((typeof(used_points) = 'integer' AND used_points BETWEEN 0 AND 9007199254740991)),
  blocked_until_ms INTEGER NULL CHECK (blocked_until_ms IS NULL OR (typeof(blocked_until_ms) = 'integer' AND blocked_until_ms BETWEEN 0 AND 9007199254740991)),
  UNIQUE (scope,subject_hash),
  CHECK (expires_at_ms > window_started_at_ms),
  CHECK (blocked_until_ms IS NULL OR blocked_until_ms >= window_started_at_ms)
);
CREATE INDEX idx_auth_rate_limit_buckets_expires ON auth_rate_limit_buckets (expires_at_ms);

CREATE TABLE admin_audit_log (
  audit_id TEXT NOT NULL PRIMARY KEY CHECK ((length(audit_id) = 36 AND substr(audit_id,9,1) = '-' AND substr(audit_id,14,1) = '-' AND substr(audit_id,19,1) = '-' AND substr(audit_id,24,1) = '-' AND length(replace(audit_id,'-','')) = 32 AND replace(audit_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  actor_member_id TEXT NULL CHECK (actor_member_id IS NULL OR (length(actor_member_id) = 36 AND substr(actor_member_id,9,1) = '-' AND substr(actor_member_id,14,1) = '-' AND substr(actor_member_id,19,1) = '-' AND substr(actor_member_id,24,1) = '-' AND length(replace(actor_member_id,'-','')) = 32 AND replace(actor_member_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  actor_account_id TEXT NULL CHECK (actor_account_id IS NULL OR (length(actor_account_id) = 36 AND substr(actor_account_id,9,1) = '-' AND substr(actor_account_id,14,1) = '-' AND substr(actor_account_id,19,1) = '-' AND substr(actor_account_id,24,1) = '-' AND length(replace(actor_account_id,'-','')) = 32 AND replace(actor_account_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  actor_token_id TEXT NULL CHECK (actor_token_id IS NULL OR (length(actor_token_id) = 36 AND substr(actor_token_id,9,1) = '-' AND substr(actor_token_id,14,1) = '-' AND substr(actor_token_id,19,1) = '-' AND substr(actor_token_id,24,1) = '-' AND length(replace(actor_token_id,'-','')) = 32 AND replace(actor_token_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
  target_type TEXT NOT NULL CHECK (length(target_type) BETWEEN 1 AND 64),
  target_id TEXT NULL CHECK (target_id IS NULL OR (length(target_id) = 36 AND substr(target_id,9,1) = '-' AND substr(target_id,14,1) = '-' AND substr(target_id,19,1) = '-' AND substr(target_id,24,1) = '-' AND length(replace(target_id,'-','')) = 32 AND replace(target_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  result TEXT NOT NULL DEFAULT 'success' CHECK (result IN ('success','denied','failure')),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  occurred_at_ms INTEGER NOT NULL CHECK ((typeof(occurred_at_ms) = 'integer' AND occurred_at_ms BETWEEN 0 AND 9007199254740991)),
  FOREIGN KEY (actor_member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (actor_account_id) REFERENCES login_accounts(account_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (actor_token_id) REFERENCES report_tokens(token_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_admin_audit_log_time ON admin_audit_log (occurred_at_ms, audit_id);
CREATE INDEX idx_admin_audit_log_actor ON admin_audit_log (actor_member_id, occurred_at_ms);
CREATE INDEX idx_admin_audit_log_target ON admin_audit_log (target_type, target_id);

CREATE TABLE legacy_attribution_map (
  mapping_id TEXT NOT NULL PRIMARY KEY CHECK ((length(mapping_id) = 36 AND substr(mapping_id,9,1) = '-' AND substr(mapping_id,14,1) = '-' AND substr(mapping_id,19,1) = '-' AND substr(mapping_id,24,1) = '-' AND length(replace(mapping_id,'-','')) = 32 AND replace(mapping_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  legacy_user_id TEXT NOT NULL CHECK (length(legacy_user_id) BETWEEN 1 AND 255),
  member_id TEXT NULL CHECK (member_id IS NULL OR (length(member_id) = 36 AND substr(member_id,9,1) = '-' AND substr(member_id,14,1) = '-' AND substr(member_id,19,1) = '-' AND substr(member_id,24,1) = '-' AND length(replace(member_id,'-','')) = 32 AND replace(member_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','mapped','ignored')),
  source_import_ref TEXT NOT NULL CHECK (length(source_import_ref) BETWEEN 1 AND 128),
  decision_reason TEXT NULL CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 1 AND 512),
  decided_by_member_id TEXT NULL CHECK (decided_by_member_id IS NULL OR (length(decided_by_member_id) = 36 AND substr(decided_by_member_id,9,1) = '-' AND substr(decided_by_member_id,14,1) = '-' AND substr(decided_by_member_id,19,1) = '-' AND substr(decided_by_member_id,24,1) = '-' AND length(replace(decided_by_member_id,'-','')) = 32 AND replace(decided_by_member_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  created_at_ms INTEGER NOT NULL CHECK ((typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991)),
  decided_at_ms INTEGER NULL CHECK (decided_at_ms IS NULL OR (typeof(decided_at_ms) = 'integer' AND decided_at_ms BETWEEN 0 AND 9007199254740991)),
  UNIQUE (legacy_user_id),
  CHECK ((status = 'mapped' AND member_id IS NOT NULL AND decided_at_ms IS NOT NULL AND decision_reason IS NOT NULL) OR (status IN ('pending','ignored') AND member_id IS NULL)),
  FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (decided_by_member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_legacy_attribution_map_member ON legacy_attribution_map (member_id);
CREATE INDEX idx_legacy_attribution_map_status ON legacy_attribution_map (status);

CREATE TABLE portal_identity_state (
  state_id TEXT NOT NULL PRIMARY KEY CHECK ((length(state_id) = 36 AND substr(state_id,9,1) = '-' AND substr(state_id,14,1) = '-' AND substr(state_id,19,1) = '-' AND substr(state_id,24,1) = '-' AND length(replace(state_id,'-','')) = 32 AND replace(state_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  singleton_key INTEGER NOT NULL UNIQUE CHECK (singleton_key = 1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK ((typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991)),
  initialized_at_ms INTEGER NULL CHECK (initialized_at_ms IS NULL OR (typeof(initialized_at_ms) = 'integer' AND initialized_at_ms BETWEEN 0 AND 9007199254740991)),
  initialized_by_member_id TEXT NULL CHECK (initialized_by_member_id IS NULL OR (length(initialized_by_member_id) = 36 AND substr(initialized_by_member_id,9,1) = '-' AND substr(initialized_by_member_id,14,1) = '-' AND substr(initialized_by_member_id,19,1) = '-' AND substr(initialized_by_member_id,24,1) = '-' AND length(replace(initialized_by_member_id,'-','')) = 32 AND replace(initialized_by_member_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  updated_at_ms INTEGER NOT NULL CHECK ((typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991)),
  FOREIGN KEY (initialized_by_member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE portal_schema_migrations (
  migration_id TEXT NOT NULL PRIMARY KEY CHECK ((length(migration_id) = 36 AND substr(migration_id,9,1) = '-' AND substr(migration_id,14,1) = '-' AND substr(migration_id,19,1) = '-' AND substr(migration_id,24,1) = '-' AND length(replace(migration_id,'-','')) = 32 AND replace(migration_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  version INTEGER NOT NULL UNIQUE CHECK (version > 0 AND version <= 2147483647),
  checksum TEXT NOT NULL CHECK ((length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*')),
  status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started','completed','failed')),
  last_completed_step INTEGER NOT NULL DEFAULT 0 CHECK ((typeof(last_completed_step) = 'integer' AND last_completed_step BETWEEN 0 AND 9007199254740991)),
  checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json)),
  started_at_ms INTEGER NOT NULL CHECK ((typeof(started_at_ms) = 'integer' AND started_at_ms BETWEEN 0 AND 9007199254740991)),
  completed_at_ms INTEGER NULL CHECK (completed_at_ms IS NULL OR (typeof(completed_at_ms) = 'integer' AND completed_at_ms BETWEEN 0 AND 9007199254740991)),
  CHECK ((status = 'completed' AND completed_at_ms IS NOT NULL AND completed_at_ms >= started_at_ms) OR (status IN ('started','failed') AND completed_at_ms IS NULL))
);

-- 以下 usage_event 保留 v3 原始列与语义；新增外键均可空以承接旧数据。
CREATE TABLE usage_event (
  event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 255) PRIMARY KEY,
  session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 255),
  seq INTEGER NOT NULL CHECK ((typeof(seq) = 'integer' AND seq BETWEEN 0 AND 9007199254740991)),
  ts INTEGER NOT NULL CHECK ((typeof(ts) = 'integer' AND ts BETWEEN 0 AND 9007199254740991)),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 0 AND 255),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 0 AND 255),
  cwd TEXT NULL,
  user_id TEXT NULL CHECK (user_id IS NULL OR length(user_id) BETWEEN 1 AND 255),
  user_name TEXT NULL CHECK (user_name IS NULL OR length(user_name) BETWEEN 1 AND 255),
  group_name TEXT NULL CHECK (group_name IS NULL OR length(group_name) BETWEEN 1 AND 255),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK ((typeof(input_tokens) = 'integer' AND input_tokens BETWEEN 0 AND 9007199254740991)),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK ((typeof(output_tokens) = 'integer' AND output_tokens BETWEEN 0 AND 9007199254740991)),
  cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK ((typeof(cache_read_tokens) = 'integer' AND cache_read_tokens BETWEEN 0 AND 9007199254740991)),
  cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK ((typeof(cache_write_tokens) = 'integer' AND cache_write_tokens BETWEEN 0 AND 9007199254740991)),
  reasoning_tokens INTEGER NOT NULL DEFAULT 0 CHECK ((typeof(reasoning_tokens) = 'integer' AND reasoning_tokens BETWEEN 0 AND 9007199254740991)),
  turn INTEGER NULL CHECK (turn IS NULL OR (typeof(turn) = 'integer' AND turn BETWEEN -9007199254740991 AND 9007199254740991)),
  step INTEGER NULL CHECK (step IS NULL OR (typeof(step) = 'integer' AND step BETWEEN -9007199254740991 AND 9007199254740991)),
  member_id TEXT NULL CHECK (member_id IS NULL OR (length(member_id) = 36 AND substr(member_id,9,1) = '-' AND substr(member_id,14,1) = '-' AND substr(member_id,19,1) = '-' AND substr(member_id,24,1) = '-' AND length(replace(member_id,'-','')) = 32 AND replace(member_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  report_token_id TEXT NULL CHECK (report_token_id IS NULL OR (length(report_token_id) = 36 AND substr(report_token_id,9,1) = '-' AND substr(report_token_id,14,1) = '-' AND substr(report_token_id,19,1) = '-' AND substr(report_token_id,24,1) = '-' AND length(replace(report_token_id,'-','')) = 32 AND replace(report_token_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  received_at_ms INTEGER NULL CHECK (received_at_ms IS NULL OR (typeof(received_at_ms) = 'integer' AND received_at_ms BETWEEN 0 AND 9007199254740991)),
  FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (report_token_id) REFERENCES report_tokens(token_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (member_id,report_token_id) REFERENCES report_tokens(member_id,token_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK (report_token_id IS NULL OR member_id IS NOT NULL)
);
CREATE INDEX idx_usage_event_ts ON usage_event (ts);
CREATE INDEX idx_usage_event_provider ON usage_event (provider);
CREATE INDEX idx_usage_event_model ON usage_event (model);
CREATE INDEX idx_usage_event_session ON usage_event (session_id);
CREATE INDEX idx_usage_event_user ON usage_event (user_id);
CREATE INDEX idx_usage_event_member_ts ON usage_event (member_id, ts);
CREATE INDEX idx_usage_event_token ON usage_event (report_token_id);

-- 仅 seed 内置角色/权限和身份互斥行；不会创建管理员账号或发放令牌。
-- 新令牌签发事务必须显式插入 identity:read + usage:write；不能给权限关系写隐式默认。
-- 旧令牌迁移按已验证的原有效权限填写 scopes，鉴权取角色权限与 scopes 的交集。
INSERT INTO roles (role_id,code,name,is_builtin,status,version,created_at_ms,updated_at_ms) VALUES ('00000000-0000-4000-8000-000000000001','admin','管理员',1,'active',1,0,0),('00000000-0000-4000-8000-000000000002','member','成员',1,'active',1,0,0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000100','identity:read','identity:read',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000101','usage:write','usage:write',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000102','stats:read','stats:read',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000103','members:read','members:read',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000104','members:manage','members:manage',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000105','tokens:manage','tokens:manage',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000106','accounts:manage','accounts:manage',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000107','roles:read','roles:read',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000108','roles:assign','roles:assign',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000109','audit:read','audit:read',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000110','groups:read','groups:read',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000111','groups:manage','groups:manage',0);
INSERT INTO role_permissions (role_id,permission_id) SELECT '00000000-0000-4000-8000-000000000001',permission_id FROM permissions;
INSERT INTO role_permissions (role_id,permission_id) SELECT '00000000-0000-4000-8000-000000000002',permission_id FROM permissions WHERE code IN ('identity:read','usage:write','stats:read','groups:read');
INSERT INTO portal_identity_state (state_id,singleton_key,revision,updated_at_ms) VALUES ('00000000-0000-4000-8000-000000000003',1,0,0);
-- 迁移记录由执行器在核实 DDL 后写入真实 checksum；本文件不伪造迁移完成证据。
-- 此设计不创建本地扫描的 file_watermark/session_state，也不重定义 ingest_run。
`
export const PORTAL_MYSQL_V5_SQL = `-- 数据库 v5：分组（多对多）+ 权限码 groups:*。
-- 目标 MySQL 8.4；InnoDB/utf8mb4_0900_bin（NO PAD），原始事件键不 trim。
-- 不执行 ALTER/DROP，不修改本地 usage.sqlite 的 schema v3。
-- 部署前必须另行实现带备份、版本闸门与恢复点的生产迁移。
-- UUID 使用小写标准格式；旧 event_id/session_id/user_id 保持原语义。
-- 所有时间为 epoch 毫秒；所有数值不超过 JavaScript 安全整数上限。
-- token/session/binding 仅存 32 字节摘要的 64 位十六进制串。
-- 验证码答案存 HMAC-SHA256，密钥由部署环境提供，绝不保存四位答案或裸 SHA256。
-- 密码哈希复用带算法/版本/盐的编码；数据库不生成、不存明文密码。
-- 历史引用全部 RESTRICT，不以删除人员/令牌清除历史。
-- 目标 MySQL 8.4；InnoDB/utf8mb4_0900_bin（NO PAD），原始事件键不 trim。

CREATE TABLE member_groups (
  group_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (group_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  name VARCHAR(64) NOT NULL CHECK (CHAR_LENGTH(name) BETWEEN 1 AND 64),
  status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  version BIGINT NOT NULL DEFAULT 1 CHECK ((version BETWEEN 1 AND 9007199254740991)),
  created_at_ms BIGINT NOT NULL CHECK ((created_at_ms BETWEEN 0 AND 9007199254740991)),
  updated_at_ms BIGINT NOT NULL CHECK ((updated_at_ms BETWEEN 0 AND 9007199254740991)),
  UNIQUE (name),
  CHECK (updated_at_ms >= created_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE members (
  member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (member_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  display_name VARCHAR(32) NOT NULL CHECK (CHAR_LENGTH(display_name) BETWEEN 1 AND 32),
  status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','archived')),
  version BIGINT NOT NULL DEFAULT 1 CHECK ((version BETWEEN 1 AND 9007199254740991)),
  created_at_ms BIGINT NOT NULL CHECK ((created_at_ms BETWEEN 0 AND 9007199254740991)),
  updated_at_ms BIGINT NOT NULL CHECK ((updated_at_ms BETWEEN 0 AND 9007199254740991)),
  CHECK (updated_at_ms >= created_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX idx_members_status ON members (status);

-- ★ 人员与分组是**多对多**：一个人可以同时属于多个分组。
CREATE TABLE member_group_assignments (
  member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (member_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  group_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (group_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  created_at_ms BIGINT NOT NULL CHECK ((created_at_ms BETWEEN 0 AND 9007199254740991)),
  PRIMARY KEY (member_id,group_id),
  FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (group_id) REFERENCES member_groups(group_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX idx_member_group_assignments_group ON member_group_assignments (group_id);

CREATE TABLE roles (
  role_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (role_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  code VARCHAR(64) NOT NULL CHECK (CHAR_LENGTH(code) BETWEEN 1 AND 64),
  name VARCHAR(128) NOT NULL CHECK (CHAR_LENGTH(name) BETWEEN 1 AND 128),
  is_builtin TINYINT NOT NULL DEFAULT 0 CHECK (is_builtin IN (0,1)),
  status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  version BIGINT NOT NULL DEFAULT 1 CHECK ((version BETWEEN 1 AND 9007199254740991)),
  created_at_ms BIGINT NOT NULL CHECK ((created_at_ms BETWEEN 0 AND 9007199254740991)),
  updated_at_ms BIGINT NOT NULL CHECK ((updated_at_ms BETWEEN 0 AND 9007199254740991)),
  UNIQUE (code),
  CHECK (updated_at_ms >= created_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE permissions (
  permission_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (permission_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  code VARCHAR(64) NOT NULL CHECK (CHAR_LENGTH(code) BETWEEN 1 AND 64),
  description VARCHAR(255) NOT NULL CHECK (CHAR_LENGTH(description) BETWEEN 1 AND 255),
  created_at_ms BIGINT NOT NULL CHECK ((created_at_ms BETWEEN 0 AND 9007199254740991)),
  UNIQUE (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE member_roles (
  member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (member_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  role_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (role_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  granted_at_ms BIGINT NOT NULL CHECK ((granted_at_ms BETWEEN 0 AND 9007199254740991)),
  PRIMARY KEY (member_id,role_id),
  FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (role_id) REFERENCES roles(role_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX idx_member_roles_role ON member_roles (role_id);

CREATE TABLE role_permissions (
  role_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (role_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  permission_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (permission_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  PRIMARY KEY (role_id,permission_id),
  FOREIGN KEY (role_id) REFERENCES roles(role_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (permission_id) REFERENCES permissions(permission_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX idx_role_permissions_permission ON role_permissions (permission_id);

CREATE TABLE login_accounts (
  account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (account_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (member_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  username_normalized VARCHAR(64) NOT NULL CHECK (CHAR_LENGTH(username_normalized) BETWEEN 1 AND 64),
  password_hash VARCHAR(512) NOT NULL CHECK (CHAR_LENGTH(password_hash) BETWEEN 1 AND 512),
  password_version BIGINT NOT NULL DEFAULT 1 CHECK ((password_version BETWEEN 1 AND 9007199254740991)),
  enabled TINYINT NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  version BIGINT NOT NULL DEFAULT 1 CHECK ((version BETWEEN 1 AND 9007199254740991)),
  created_at_ms BIGINT NOT NULL CHECK ((created_at_ms BETWEEN 0 AND 9007199254740991)),
  updated_at_ms BIGINT NOT NULL CHECK ((updated_at_ms BETWEEN 0 AND 9007199254740991)),
  UNIQUE (member_id),
  UNIQUE (username_normalized),
  CHECK (username_normalized REGEXP '^[a-z0-9][a-z0-9_.-]{2,63}$'),
  CHECK (password_hash LIKE '$atr-scrypt$1$%' AND length(password_hash) = 111),
  CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX idx_login_accounts_enabled ON login_accounts (enabled);

CREATE TABLE report_tokens (
  token_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (token_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (member_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (token_hash REGEXP '^[0-9a-f]{64}$'),
  token_prefix VARCHAR(24) NOT NULL CHECK (CHAR_LENGTH(token_prefix) BETWEEN 1 AND 24),
  label VARCHAR(128) NOT NULL CHECK (CHAR_LENGTH(label) BETWEEN 1 AND 128),
  status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  version BIGINT NOT NULL DEFAULT 1 CHECK ((version BETWEEN 1 AND 9007199254740991)),
  created_at_ms BIGINT NOT NULL CHECK ((created_at_ms BETWEEN 0 AND 9007199254740991)),
  expires_at_ms BIGINT NULL CHECK (expires_at_ms IS NULL OR (expires_at_ms BETWEEN 0 AND 9007199254740991)),
  revoked_at_ms BIGINT NULL CHECK (revoked_at_ms IS NULL OR (revoked_at_ms BETWEEN 0 AND 9007199254740991)),
  UNIQUE (token_hash),
  UNIQUE (member_id,token_id),
  CHECK (expires_at_ms IS NULL OR expires_at_ms > created_at_ms),
  CHECK ((status = 'active' AND revoked_at_ms IS NULL) OR (status = 'revoked' AND revoked_at_ms IS NOT NULL AND revoked_at_ms >= created_at_ms)),
  FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX idx_report_tokens_member ON report_tokens (member_id);
CREATE INDEX idx_report_tokens_expires ON report_tokens (expires_at_ms);

CREATE TABLE report_token_scopes (
  token_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (token_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  permission_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (permission_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  PRIMARY KEY (token_id,permission_id),
  FOREIGN KEY (token_id) REFERENCES report_tokens(token_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (permission_id) REFERENCES permissions(permission_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX idx_report_token_scopes_permission ON report_token_scopes (permission_id);

CREATE TABLE auth_sessions (
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (session_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  session_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (session_hash REGEXP '^[0-9a-f]{64}$'),
  account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (account_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  password_version BIGINT NOT NULL CHECK ((password_version BETWEEN 1 AND 9007199254740991)),
  created_at_ms BIGINT NOT NULL CHECK ((created_at_ms BETWEEN 0 AND 9007199254740991)),
  expires_at_ms BIGINT NOT NULL CHECK ((expires_at_ms BETWEEN 0 AND 9007199254740991)),
  last_seen_at_ms BIGINT NOT NULL CHECK ((last_seen_at_ms BETWEEN 0 AND 9007199254740991)),
  revoked_at_ms BIGINT NULL CHECK (revoked_at_ms IS NULL OR (revoked_at_ms BETWEEN 0 AND 9007199254740991)),
  UNIQUE (session_hash),
  CHECK (expires_at_ms > created_at_ms),
  CHECK (last_seen_at_ms >= created_at_ms),
  CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms),
  FOREIGN KEY (account_id) REFERENCES login_accounts(account_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX idx_auth_sessions_account ON auth_sessions (account_id);
CREATE INDEX idx_auth_sessions_expires ON auth_sessions (expires_at_ms);

CREATE TABLE auth_challenges (
  challenge_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (challenge_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  challenge_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (challenge_hash REGEXP '^[0-9a-f]{64}$'),
  binding_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (binding_hash REGEXP '^[0-9a-f]{64}$'),
  answer_hmac CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (answer_hmac REGEXP '^[0-9a-f]{64}$'),
  hmac_key_id VARCHAR(64) NOT NULL CHECK (CHAR_LENGTH(hmac_key_id) BETWEEN 1 AND 64),
  created_at_ms BIGINT NOT NULL CHECK ((created_at_ms BETWEEN 0 AND 9007199254740991)),
  expires_at_ms BIGINT NOT NULL CHECK ((expires_at_ms BETWEEN 0 AND 9007199254740991)),
  consumed_at_ms BIGINT NULL CHECK (consumed_at_ms IS NULL OR (consumed_at_ms BETWEEN 0 AND 9007199254740991)),
  attempt_count BIGINT NOT NULL DEFAULT 0 CHECK ((attempt_count BETWEEN 0 AND 9007199254740991)),
  UNIQUE (challenge_hash),
  CHECK (expires_at_ms > created_at_ms),
  CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX idx_auth_challenges_binding ON auth_challenges (binding_hash);
CREATE INDEX idx_auth_challenges_expires ON auth_challenges (expires_at_ms);

CREATE TABLE auth_rate_limit_buckets (
  bucket_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (bucket_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  scope VARCHAR(64) NOT NULL CHECK (CHAR_LENGTH(scope) BETWEEN 1 AND 64),
  subject_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (subject_hash REGEXP '^[0-9a-f]{64}$'),
  window_started_at_ms BIGINT NOT NULL CHECK ((window_started_at_ms BETWEEN 0 AND 9007199254740991)),
  expires_at_ms BIGINT NOT NULL CHECK ((expires_at_ms BETWEEN 0 AND 9007199254740991)),
  used_points BIGINT NOT NULL DEFAULT 0 CHECK ((used_points BETWEEN 0 AND 9007199254740991)),
  blocked_until_ms BIGINT NULL CHECK (blocked_until_ms IS NULL OR (blocked_until_ms BETWEEN 0 AND 9007199254740991)),
  UNIQUE (scope,subject_hash),
  CHECK (expires_at_ms > window_started_at_ms),
  CHECK (blocked_until_ms IS NULL OR blocked_until_ms >= window_started_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX idx_auth_rate_limit_buckets_expires ON auth_rate_limit_buckets (expires_at_ms);

CREATE TABLE admin_audit_log (
  audit_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (audit_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  actor_member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL CHECK (actor_member_id IS NULL OR actor_member_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  actor_account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL CHECK (actor_account_id IS NULL OR actor_account_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  actor_token_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL CHECK (actor_token_id IS NULL OR actor_token_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  action VARCHAR(64) NOT NULL CHECK (CHAR_LENGTH(action) BETWEEN 1 AND 64),
  target_type VARCHAR(64) NOT NULL CHECK (CHAR_LENGTH(target_type) BETWEEN 1 AND 64),
  target_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL CHECK (target_id IS NULL OR target_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  result VARCHAR(32) NOT NULL DEFAULT 'success' CHECK (result IN ('success','denied','failure')),
  request_id VARCHAR(128) NOT NULL CHECK (CHAR_LENGTH(request_id) BETWEEN 1 AND 128),
  metadata_json JSON NOT NULL,
  occurred_at_ms BIGINT NOT NULL CHECK ((occurred_at_ms BETWEEN 0 AND 9007199254740991)),
  FOREIGN KEY (actor_member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (actor_account_id) REFERENCES login_accounts(account_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (actor_token_id) REFERENCES report_tokens(token_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX idx_admin_audit_log_time ON admin_audit_log (occurred_at_ms, audit_id);
CREATE INDEX idx_admin_audit_log_actor ON admin_audit_log (actor_member_id, occurred_at_ms);
CREATE INDEX idx_admin_audit_log_target ON admin_audit_log (target_type, target_id);

CREATE TABLE legacy_attribution_map (
  mapping_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (mapping_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  legacy_user_id VARCHAR(255) NOT NULL CHECK (CHAR_LENGTH(legacy_user_id) BETWEEN 1 AND 255),
  member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL CHECK (member_id IS NULL OR member_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  status VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','mapped','ignored')),
  source_import_ref VARCHAR(128) NOT NULL CHECK (CHAR_LENGTH(source_import_ref) BETWEEN 1 AND 128),
  decision_reason VARCHAR(512) NULL CHECK (decision_reason IS NULL OR CHAR_LENGTH(decision_reason) BETWEEN 1 AND 512),
  decided_by_member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL CHECK (decided_by_member_id IS NULL OR decided_by_member_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  created_at_ms BIGINT NOT NULL CHECK ((created_at_ms BETWEEN 0 AND 9007199254740991)),
  decided_at_ms BIGINT NULL CHECK (decided_at_ms IS NULL OR (decided_at_ms BETWEEN 0 AND 9007199254740991)),
  UNIQUE (legacy_user_id),
  CHECK ((status = 'mapped' AND member_id IS NOT NULL AND decided_at_ms IS NOT NULL AND decision_reason IS NOT NULL) OR (status IN ('pending','ignored') AND member_id IS NULL)),
  FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (decided_by_member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX idx_legacy_attribution_map_member ON legacy_attribution_map (member_id);
CREATE INDEX idx_legacy_attribution_map_status ON legacy_attribution_map (status);

CREATE TABLE portal_identity_state (
  state_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (state_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  singleton_key TINYINT NOT NULL UNIQUE CHECK (singleton_key = 1),
  revision BIGINT NOT NULL DEFAULT 0 CHECK ((revision BETWEEN 0 AND 9007199254740991)),
  initialized_at_ms BIGINT NULL CHECK (initialized_at_ms IS NULL OR (initialized_at_ms BETWEEN 0 AND 9007199254740991)),
  initialized_by_member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL CHECK (initialized_by_member_id IS NULL OR initialized_by_member_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  updated_at_ms BIGINT NOT NULL CHECK ((updated_at_ms BETWEEN 0 AND 9007199254740991)),
  FOREIGN KEY (initialized_by_member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE portal_schema_migrations (
  migration_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (migration_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  version INT NOT NULL UNIQUE CHECK (version > 0 AND version <= 2147483647),
  checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (checksum REGEXP '^[0-9a-f]{64}$'),
  status VARCHAR(32) NOT NULL DEFAULT 'started' CHECK (status IN ('started','completed','failed')),
  last_completed_step BIGINT NOT NULL DEFAULT 0 CHECK ((last_completed_step BETWEEN 0 AND 9007199254740991)),
  checkpoint_json JSON NOT NULL,
  started_at_ms BIGINT NOT NULL CHECK ((started_at_ms BETWEEN 0 AND 9007199254740991)),
  completed_at_ms BIGINT NULL CHECK (completed_at_ms IS NULL OR (completed_at_ms BETWEEN 0 AND 9007199254740991)),
  CHECK ((status = 'completed' AND completed_at_ms IS NOT NULL AND completed_at_ms >= started_at_ms) OR (status IN ('started','failed') AND completed_at_ms IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- 以下 usage_event 保留 v3 原始列与语义；新增外键均可空以承接旧数据。
CREATE TABLE usage_event (
  event_id VARCHAR(255) NOT NULL CHECK (CHAR_LENGTH(event_id) BETWEEN 1 AND 255) PRIMARY KEY,
  session_id VARCHAR(255) NOT NULL CHECK (CHAR_LENGTH(session_id) BETWEEN 1 AND 255),
  seq BIGINT NOT NULL CHECK ((seq BETWEEN 0 AND 9007199254740991)),
  ts BIGINT NOT NULL CHECK ((ts BETWEEN 0 AND 9007199254740991)),
  provider VARCHAR(255) NOT NULL CHECK (CHAR_LENGTH(provider) BETWEEN 0 AND 255),
  model VARCHAR(255) NOT NULL CHECK (CHAR_LENGTH(model) BETWEEN 0 AND 255),
  cwd TEXT NULL,
  user_id VARCHAR(255) NULL CHECK (user_id IS NULL OR CHAR_LENGTH(user_id) BETWEEN 1 AND 255),
  user_name VARCHAR(255) NULL CHECK (user_name IS NULL OR CHAR_LENGTH(user_name) BETWEEN 1 AND 255),
  group_name VARCHAR(255) NULL CHECK (group_name IS NULL OR CHAR_LENGTH(group_name) BETWEEN 1 AND 255),
  input_tokens BIGINT NOT NULL DEFAULT 0 CHECK ((input_tokens BETWEEN 0 AND 9007199254740991)),
  output_tokens BIGINT NOT NULL DEFAULT 0 CHECK ((output_tokens BETWEEN 0 AND 9007199254740991)),
  cache_read_tokens BIGINT NOT NULL DEFAULT 0 CHECK ((cache_read_tokens BETWEEN 0 AND 9007199254740991)),
  cache_write_tokens BIGINT NOT NULL DEFAULT 0 CHECK ((cache_write_tokens BETWEEN 0 AND 9007199254740991)),
  reasoning_tokens BIGINT NOT NULL DEFAULT 0 CHECK ((reasoning_tokens BETWEEN 0 AND 9007199254740991)),
  turn BIGINT NULL CHECK (turn IS NULL OR (turn BETWEEN -9007199254740991 AND 9007199254740991)),
  step BIGINT NULL CHECK (step IS NULL OR (step BETWEEN -9007199254740991 AND 9007199254740991)),
  member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL CHECK (member_id IS NULL OR member_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  report_token_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL CHECK (report_token_id IS NULL OR report_token_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  received_at_ms BIGINT NULL CHECK (received_at_ms IS NULL OR (received_at_ms BETWEEN 0 AND 9007199254740991)),
  FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (report_token_id) REFERENCES report_tokens(token_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (member_id,report_token_id) REFERENCES report_tokens(member_id,token_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK (report_token_id IS NULL OR member_id IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX idx_usage_event_ts ON usage_event (ts);
CREATE INDEX idx_usage_event_provider ON usage_event (provider);
CREATE INDEX idx_usage_event_model ON usage_event (model);
CREATE INDEX idx_usage_event_session ON usage_event (session_id);
CREATE INDEX idx_usage_event_user ON usage_event (user_id);
CREATE INDEX idx_usage_event_member_ts ON usage_event (member_id, ts);
CREATE INDEX idx_usage_event_token ON usage_event (report_token_id);

-- 仅 seed 内置角色/权限和身份互斥行；不会创建管理员账号或发放令牌。
-- 新令牌签发事务必须显式插入 identity:read + usage:write；不能给权限关系写隐式默认。
-- 旧令牌迁移按已验证的原有效权限填写 scopes，鉴权取角色权限与 scopes 的交集。
INSERT INTO roles (role_id,code,name,is_builtin,status,version,created_at_ms,updated_at_ms) VALUES ('00000000-0000-4000-8000-000000000001','admin','管理员',1,'active',1,0,0),('00000000-0000-4000-8000-000000000002','member','成员',1,'active',1,0,0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000100','identity:read','identity:read',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000101','usage:write','usage:write',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000102','stats:read','stats:read',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000103','members:read','members:read',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000104','members:manage','members:manage',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000105','tokens:manage','tokens:manage',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000106','accounts:manage','accounts:manage',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000107','roles:read','roles:read',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000108','roles:assign','roles:assign',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000109','audit:read','audit:read',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000110','groups:read','groups:read',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000111','groups:manage','groups:manage',0);
INSERT INTO role_permissions (role_id,permission_id) SELECT '00000000-0000-4000-8000-000000000001',permission_id FROM permissions;
INSERT INTO role_permissions (role_id,permission_id) SELECT '00000000-0000-4000-8000-000000000002',permission_id FROM permissions WHERE code IN ('identity:read','usage:write','stats:read','groups:read');
INSERT INTO portal_identity_state (state_id,singleton_key,revision,updated_at_ms) VALUES ('00000000-0000-4000-8000-000000000003',1,0,0);
-- 迁移记录由执行器在核实 DDL 后写入真实 checksum；本文件不伪造迁移完成证据。
-- 此设计不创建本地扫描的 file_watermark/session_state，也不重定义 ingest_run。
`
/**
 * ★ **v6 追加**：供应商归一化规则表 + 两条权限码。
 *
 * ## 为什么是独立常量而不是直接写进上面那条 SQL
 *
 * 它要被**两处**用到，而这两处对「哪一份文本算受控定义」的要求不同：
 *
 * 1. 全新库初始化与受控校验 —— 拼进 `portalSchemaStatements()`；
 * 2. v5→v6 的迁移器 —— 只执行这一段，且**每一步都自检目标状态**，
 *    所以重复执行（resume）是安全的。
 *
 * 放在这里而不是另开一个 `portal-schema-v6.ts`：`provider_alias` 只引用
 * `members`，与 v5 的其余结构同属一份受控定义；分成两个文件会让
 * 「哪些表属于当前版本」变成两个地方各自维护，而它们必然漂移。
 *
 * ## 规则表怎么用（不是 JOIN）
 *
 * 服务端在每次看板查询前把它读成「原始名 → 展示名」的映射，
 * 再把映射内联成 `CASE` 表达式交给 SQL（见 `provider-alias.ts` 的 🚨 注释）。
 * **绝不在聚合 SQL 里 JOIN 这张表** —— 一个 provider 命中多条规则时
 * JOIN 会让事件行复制、`SUM()` 放大，而页面上只是数字变大。
 */
export const PORTAL_SQLITE_V6_ADDITIONS = `
-- ★ v6：供应商（provider）归一化规则。
-- 规则只在**查询时**生效，usage_event.provider 永远是上报当时的原值。
-- scope='global' 时 member_id 必须为 NULL；scope='member' 时必须指向一个人员。
-- 未配规则 = 原样显示（CASE 没有 ELSE 分支，见 provider-alias.ts）。
CREATE TABLE provider_alias (
  alias_id TEXT NOT NULL PRIMARY KEY CHECK ((length(alias_id) = 36 AND substr(alias_id,9,1) = '-' AND substr(alias_id,14,1) = '-' AND substr(alias_id,19,1) = '-' AND substr(alias_id,24,1) = '-' AND length(replace(alias_id,'-','')) = 32 AND replace(alias_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global','member')),
  member_id TEXT NULL CHECK (member_id IS NULL OR (length(member_id) = 36 AND substr(member_id,9,1) = '-' AND substr(member_id,14,1) = '-' AND substr(member_id,19,1) = '-' AND substr(member_id,24,1) = '-' AND length(replace(member_id,'-','')) = 32 AND replace(member_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 255),
  alias TEXT NOT NULL CHECK (length(alias) BETWEEN 1 AND 255),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at_ms INTEGER NOT NULL CHECK ((typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991)),
  updated_at_ms INTEGER NOT NULL CHECK ((typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991)),
  CHECK ((scope = 'global' AND member_id IS NULL) OR (scope = 'member' AND member_id IS NOT NULL)),
  CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
-- ⚠️ 唯一索引**两个后端逐字相同**（不用 SQLite 的部分索引）：
--   MySQL 没有「CREATE UNIQUE INDEX ... WHERE」，若这里用部分索引，
--   「受控定义逐列核对」在两种后端上就会看到两套唯一约束 ——
--   而校验器（verifyUniqueConstraints）只认 DDL 文本里的键，
--   差异会表现成「MySQL 上迁移做完了却不算成功」。
--   MySQL 的普通唯一索引把 NULL 视为相等，所以 (member_id, provider)
--   在两种后端上都同时管住「同一人员的同一 provider 只能有一条」与
--   「同一原始名只能有一条全局规则」（SQLite 侧由应用层显式查重补齐，
--   见 repository.ts 的 findProviderAlias()）。
CREATE UNIQUE INDEX idx_provider_alias_member ON provider_alias (member_id, provider);
CREATE INDEX idx_provider_alias_alias ON provider_alias (alias);
CREATE INDEX idx_provider_alias_scope ON provider_alias (scope, enabled);
`

/** MySQL 形态的 v6 追加（与 SQLite 侧**逐列同名同类型**，只差方言）。 */
export const PORTAL_MYSQL_V6_ADDITIONS = `
-- ★ v6：供应商（provider）归一化规则。
-- 规则只在**查询时**生效，usage_event.provider 永远是上报当时的原值。
-- scope='global' 时 member_id 必须为 NULL；scope='member' 时必须指向一个人员。
-- 未配规则 = 原样显示（CASE 没有 ELSE 分支，见 provider-alias.ts）。
CREATE TABLE provider_alias (
  alias_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (alias_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  scope VARCHAR(16) NOT NULL DEFAULT 'global' CHECK (scope IN ('global','member')),
  member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL CHECK (member_id IS NULL OR member_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  provider VARCHAR(255) NOT NULL CHECK (CHAR_LENGTH(provider) BETWEEN 1 AND 255),
  alias VARCHAR(255) NOT NULL CHECK (CHAR_LENGTH(alias) BETWEEN 1 AND 255),
  enabled TINYINT NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at_ms BIGINT NOT NULL CHECK ((created_at_ms BETWEEN 0 AND 9007199254740991)),
  updated_at_ms BIGINT NOT NULL CHECK ((updated_at_ms BETWEEN 0 AND 9007199254740991)),
  -- ⚠️ 这里**刻意不做生成列**。生成列会让「受控定义逐列核对」
  --   （verifyTable 的 expectedColumns）多出一列由引擎维护的列，
  --   而它并不在本文件的 DDL 文本里 —— 校验会报「列数不符」。
  --   MySQL 的普通唯一索引把 NULL 视为相等，因此 (member_id, provider)
  --   唯一索引天然就同时管住了「一个 provider 只能有一条全局规则」，
  --   与 SQLite 侧的应用层查重语义一致。
  CHECK ((scope = 'global' AND member_id IS NULL) OR (scope = 'member' AND member_id IS NOT NULL)),
  CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX idx_provider_alias_member ON provider_alias (member_id, provider);
CREATE INDEX idx_provider_alias_alias ON provider_alias (alias);
CREATE INDEX idx_provider_alias_scope ON provider_alias (scope, enabled);
`

/**
 * 权限码 `providers:read` / `providers:manage`。
 *
 * ⚠️ 两条语句都必须**幂等**（`SELECT ... WHERE NOT EXISTS`）：
 *   SQLite 里它们是随建库语句一起跑的，MySQL 侧 DDL 会隐式提交、
 *   迁移中途崩过一次就会重跑。写成裸 `INSERT` 会让 resume 直接撞主键。
 *
 * ★ 只授予**内置管理员角色**（`...0001`），与 v5 的 `groups:*` 处理一致：
 *   `groups:*` 是显式列在 member 角色的 seed 里的，而这里的追加语句
 *   不碰 member —— 普通成员不该能改全局供应商口径。
 */
export const PORTAL_V6_PERMISSION_SQL = [
  "INSERT INTO permissions (permission_id,code,description,created_at_ms) SELECT '00000000-0000-4000-8000-000000000112','providers:read','providers:read',0 WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE permission_id='00000000-0000-4000-8000-000000000112')",
  "INSERT INTO permissions (permission_id,code,description,created_at_ms) SELECT '00000000-0000-4000-8000-000000000113','providers:manage','providers:manage',0 WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE permission_id='00000000-0000-4000-8000-000000000113')",
  "INSERT INTO role_permissions (role_id,permission_id) SELECT '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000112' WHERE NOT EXISTS (SELECT 1 FROM role_permissions WHERE role_id='00000000-0000-4000-8000-000000000001' AND permission_id='00000000-0000-4000-8000-000000000112')",
  "INSERT INTO role_permissions (role_id,permission_id) SELECT '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000113' WHERE NOT EXISTS (SELECT 1 FROM role_permissions WHERE role_id='00000000-0000-4000-8000-000000000001' AND permission_id='00000000-0000-4000-8000-000000000113')",
]

/** 某后端上「v6 追加」的完整语句清单（建表 + 建索引 + 权限行）。 */
export function portalV6Statements(kind: PortalBackendKind): string[] {
  const additions = kind === 'mysql' ? PORTAL_MYSQL_V6_ADDITIONS : PORTAL_SQLITE_V6_ADDITIONS
  return [...additions.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean), ...PORTAL_V6_PERMISSION_SQL]
}

/** 某后端上 v6 追加里的**表定义**（供迁移器逐列核对）。 */
export function portalV6TableStatement(kind: PortalBackendKind, table: string): string {
  const sql = portalV6Statements(kind).find(statement => statement.startsWith(`CREATE TABLE ${table} (`))
  if (!sql) throw new Error(`缺少 v6 受控表定义：${table}`)
  return sql
}

/**
 * ★ **v7 追加**：模型单价表 + 两条权限码（费用统计）。
 *
 * ## 为什么定价粒度必须到 model
 *
 * 同一个供应商下不同模型的价差可以很大（实测 DeepSeek 官方 flash 与 pro
 * 的输出单价差约 4.4 倍），所以粒度到 provider 是不够的。
 * 一行 = 一个模型在 `[effective_from_ms, effective_to_ms]` 上的一套四类单价。
 *
 * ## 🚨 绝不存金额
 *
 * 表里只有 **token 单价**，没有 `cost` 列。费用在查询期现算：
 * `input×p_in + output×p_out + cacheRead×p_cr + cacheWrite×p_cw`
 * （口径在 `@ai-token-report/shared/price.ts`）。
 * 存金额的后果是「单价后来改对了，历史账还是错的」，而且从页面上看不出来。
 * 同理，单价带**生效区间**，所以补录或修正价格不会改写已发生的费用。
 *
 * ## 金额为什么是「整数微元 / 千 token」
 *
 * `*_micro_per_ktok`：1 微 = 1e-6 货币单位，按**千 token** 计价。
 * 用整数是因为几十万行 × 小数累加必然出现分位误差。
 * 上限 1e7 微/Ktok ≈ 10 货币单位/千 token，是现实最贵模型的数百倍余量。
 *
 * ## 与 `provider_alias` 的同一条纪律
 *
 * 单价表**参与费用计算**，但它是按 (provider, model) 把价格读进内存后相乘的，
 * **绝不 JOIN 进聚合 SQL** —— 一个模型命中多行价格时 JOIN 会复制事件行，
 * 把 `SUM()` 放大，而页面上只是数字变大（同 provider-alias.ts 的文件头）。
 */
export const PORTAL_SQLITE_V7_ADDITIONS = `
-- ★ v7：模型单价（费用统计）。
-- 精确匹配 (provider, model)；effective_to_ms = NULL 表示「至今有效」。
-- 金额一律「整数微元 / 千 token」：1 微 = 1e-6 货币单位。
-- 四种 token 类型各自独立定价，与 usage_event 的四列一一对应。
CREATE TABLE model_price (
  price_id TEXT NOT NULL PRIMARY KEY CHECK ((length(price_id) = 36 AND substr(price_id,9,1) = '-' AND substr(price_id,14,1) = '-' AND substr(price_id,19,1) = '-' AND substr(price_id,24,1) = '-' AND length(replace(price_id,'-','')) = 32 AND replace(price_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 255),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 255),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency) AND currency NOT GLOB '*[^A-Z]*'),
  input_micro_per_ktok INTEGER NOT NULL CHECK ((typeof(input_micro_per_ktok) = 'integer' AND input_micro_per_ktok BETWEEN 0 AND 10000000)),
  output_micro_per_ktok INTEGER NOT NULL CHECK ((typeof(output_micro_per_ktok) = 'integer' AND output_micro_per_ktok BETWEEN 0 AND 10000000)),
  cache_read_micro_per_ktok INTEGER NOT NULL CHECK ((typeof(cache_read_micro_per_ktok) = 'integer' AND cache_read_micro_per_ktok BETWEEN 0 AND 10000000)),
  cache_write_micro_per_ktok INTEGER NOT NULL CHECK ((typeof(cache_write_micro_per_ktok) = 'integer' AND cache_write_micro_per_ktok BETWEEN 0 AND 10000000)),
  effective_from_ms INTEGER NOT NULL CHECK ((typeof(effective_from_ms) = 'integer' AND effective_from_ms BETWEEN 0 AND 9007199254740991)),
  effective_to_ms INTEGER NULL CHECK (effective_to_ms IS NULL OR (typeof(effective_to_ms) = 'integer' AND effective_to_ms BETWEEN 0 AND 9007199254740991)),
  note TEXT NULL CHECK (note IS NULL OR length(note) <= 255),
  created_at_ms INTEGER NOT NULL CHECK ((typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991)),
  updated_at_ms INTEGER NOT NULL CHECK ((typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991)),
  CHECK (effective_to_ms IS NULL OR effective_to_ms >= effective_from_ms),
  CHECK (updated_at_ms >= created_at_ms)
);
-- ⚠️ 唯一索引**两个后端逐字相同**（不用 SQLite 的部分索引，理由同 v6）。
--   它只兜住「同一模型的同一生效起点只有一行」这一条**精确重复**；
--   「区间不得重叠」数据库管不住（两行部分重叠的区间都能插进去），
--   必须由应用层显式查重兜住（shared/price.ts 的 findPriceConflicts()）——
--   两行重叠价格会让 resolvePrice() 任选一行，费用随机偏差且不报错。
CREATE UNIQUE INDEX idx_model_price_span ON model_price (provider, model, effective_from_ms);
CREATE INDEX idx_model_price_target ON model_price (provider, model);
`

/** MySQL 形态的 v7 追加（与 SQLite 侧**逐列同名**，只差方言与列宽写法）。 */
export const PORTAL_MYSQL_V7_ADDITIONS = `
-- ★ v7：模型单价（费用统计）。
-- 精确匹配 (provider, model)；effective_to_ms = NULL 表示「至今有效」。
-- 金额一律「整数微元 / 千 token」：1 微 = 1e-6 货币单位。
-- int 足够：上限 1e7 远小于 int 的 2.1e9，且上限由应用层常量统一收口。
CREATE TABLE model_price (
  price_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (price_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  provider VARCHAR(255) NOT NULL CHECK (CHAR_LENGTH(provider) BETWEEN 1 AND 255),
  model VARCHAR(255) NOT NULL CHECK (CHAR_LENGTH(model) BETWEEN 1 AND 255),
  currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (currency REGEXP '^[A-Z]{3}$'),
  input_micro_per_ktok INT NOT NULL CHECK (input_micro_per_ktok BETWEEN 0 AND 10000000),
  output_micro_per_ktok INT NOT NULL CHECK (output_micro_per_ktok BETWEEN 0 AND 10000000),
  cache_read_micro_per_ktok INT NOT NULL CHECK (cache_read_micro_per_ktok BETWEEN 0 AND 10000000),
  cache_write_micro_per_ktok INT NOT NULL CHECK (cache_write_micro_per_ktok BETWEEN 0 AND 10000000),
  effective_from_ms BIGINT NOT NULL CHECK (effective_from_ms BETWEEN 0 AND 9007199254740991),
  effective_to_ms BIGINT NULL CHECK (effective_to_ms IS NULL OR effective_to_ms BETWEEN 0 AND 9007199254740991),
  note VARCHAR(255) NULL,
  created_at_ms BIGINT NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms BIGINT NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (effective_to_ms IS NULL OR effective_to_ms >= effective_from_ms),
  CHECK (updated_at_ms >= created_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
-- ⚠️ 这个唯一索引的键长是 255*4 + 255*4 + 8 = 2048 字节。
--   它只在 InnoDB 的 DYNAMIC 行格式（MySQL 8 默认，上限 3072 字节）下合法；
--   若把库建在 COMPACT 行格式上会直接 errno 1071。本仓要求 MySQL 8.0.16+
--   （用到了 CHECK 约束与 utf8mb4_0900_bin），所以默认就是 DYNAMIC。
CREATE UNIQUE INDEX idx_model_price_span ON model_price (provider, model, effective_from_ms);
CREATE INDEX idx_model_price_target ON model_price (provider, model);
`

/**
 * 权限码 `cost:read` / `pricing:manage`。
 *
 * UUID 续在 `providers:*`（`…112` / `…113`）之后，用 `…114` / `…115`。
 * 幂等写法与理由同 v6（MySQL 的 DDL 会隐式提交，迁移崩过一次就会重跑）。
 *
 * ★ `cost:read` 只授予**内置管理员角色**：费用能反推预算与议价空间，
 *   不是每个有 `stats:read` 的人都该看到。需要放开时在角色页显式授予，
 *   而不是把它塞进基础角色 —— 默认可见的金额改不回「不可见」。
 */
export const PORTAL_V7_PERMISSION_SQL = [
  "INSERT INTO permissions (permission_id,code,description,created_at_ms) SELECT '00000000-0000-4000-8000-000000000114','cost:read','cost:read',0 WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE permission_id='00000000-0000-4000-8000-000000000114')",
  "INSERT INTO permissions (permission_id,code,description,created_at_ms) SELECT '00000000-0000-4000-8000-000000000115','pricing:manage','pricing:manage',0 WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE permission_id='00000000-0000-4000-8000-000000000115')",
  "INSERT INTO role_permissions (role_id,permission_id) SELECT '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000114' WHERE NOT EXISTS (SELECT 1 FROM role_permissions WHERE role_id='00000000-0000-4000-8000-000000000001' AND permission_id='00000000-0000-4000-8000-000000000114')",
  "INSERT INTO role_permissions (role_id,permission_id) SELECT '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000115' WHERE NOT EXISTS (SELECT 1 FROM role_permissions WHERE role_id='00000000-0000-4000-8000-000000000001' AND permission_id='00000000-0000-4000-8000-000000000115')",
]

/** 某后端上「v7 追加」的完整语句清单（建表 + 建索引 + 权限行）。 */
export function portalV7Statements(kind: PortalBackendKind): string[] {
  const additions = kind === 'mysql' ? PORTAL_MYSQL_V7_ADDITIONS : PORTAL_SQLITE_V7_ADDITIONS
  return [...additions.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean), ...PORTAL_V7_PERMISSION_SQL]
}

/** 某后端上 v7 追加里的**表定义**（供迁移器逐列核对）。 */
export function portalV7TableStatement(kind: PortalBackendKind, table: string): string {
  const sql = portalV7Statements(kind).find(statement => statement.startsWith(`CREATE TABLE ${table} (`))
  if (!sql) throw new Error(`缺少 v7 受控表定义：${table}`)
  return sql
}

export const PORTAL_SQLITE_INGEST_SQL = `CREATE TABLE IF NOT EXISTS ingest_run (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  last_ingest_ms        INTEGER NOT NULL,
  last_scan_events      INTEGER NOT NULL,
  total_events_ingested INTEGER NOT NULL,
  mismatch_count        INTEGER NOT NULL,
  files_failed          INTEGER NOT NULL,
  frames_failed         INTEGER NOT NULL,
  -- 最近一轮的解析计数（新增列；旧库由 rebuildSchema 兜底重建）
  frames_ok             INTEGER NOT NULL DEFAULT 0,
  usage_events          INTEGER NOT NULL DEFAULT 0,
  assistant_without_usage INTEGER NOT NULL DEFAULT 0,
  retry_started         INTEGER NOT NULL DEFAULT 0,
  retry                 INTEGER NOT NULL DEFAULT 0,
  attempts              INTEGER NOT NULL DEFAULT 0,
  missing_provider      INTEGER NOT NULL DEFAULT 0,
  files_scanned         INTEGER NOT NULL DEFAULT 0,
  -- 事件类型分布与 provider 列表，JSON 编码存储。
  -- 用 JSON 而不是关联表：它们只用于展示、从不参与查询与聚合，
  -- 为它们建两张表会让 ingest 事务多两次写入而无任何收益。
  event_types_json      TEXT NOT NULL DEFAULT '{}',
  providers_json        TEXT NOT NULL DEFAULT '[]'
);`
export const PORTAL_MYSQL_INGEST_SQL = `CREATE TABLE IF NOT EXISTS ingest_run (
  id                      TINYINT NOT NULL PRIMARY KEY,
  last_ingest_ms          BIGINT  NOT NULL,
  last_scan_events        BIGINT  NOT NULL,
  total_events_ingested   BIGINT  NOT NULL,
  mismatch_count          BIGINT  NOT NULL,
  files_failed            BIGINT  NOT NULL,
  frames_failed           BIGINT  NOT NULL,
  frames_ok               BIGINT  NOT NULL DEFAULT 0,
  usage_events            BIGINT  NOT NULL DEFAULT 0,
  assistant_without_usage BIGINT  NOT NULL DEFAULT 0,
  retry_started           BIGINT  NOT NULL DEFAULT 0,
  retry                   BIGINT  NOT NULL DEFAULT 0,
  attempts                BIGINT  NOT NULL DEFAULT 0,
  missing_provider        BIGINT  NOT NULL DEFAULT 0,
  files_scanned           BIGINT  NOT NULL DEFAULT 0,
  event_types_json        TEXT    NOT NULL,
  providers_json          TEXT    NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`

/**
 * 受控 DDL 的全部语句（= v5 结构 + v6 追加）。
 *
 * ★ 这是**唯一**的「当前版本有哪些表」的来源：建库、逐表核对、建索引
 *   全都从这里取。往 `PORTAL_SQLITE_V6_ADDITIONS` 里加一张表，
 *   上面三件事自动跟上 —— 不存在「新表建了但校验没覆盖」的空档。
 *
 * ⚠️ 权限行（`INSERT ... WHERE NOT EXISTS`）也会被返回。调用方有两种：
 *   全新库初始化按顺序 `exec` 全部语句（正确）；
 *   迁移器的 `ensureV5Indexes` 只挑 `CREATE INDEX` 前缀的（也正确）。
 *   若将来有人把这里改回「只返回 DDL」，权限码就会在迁到 v6 之后缺失 ——
 *   表现是管理员进不去配置页，而库的版本号明明是 6。
 *
 * 设计 SQL 没有触发器或字符串内分号；只在本模块的受控 SQL 上拆句。
 */
export function portalSchemaStatements(kind: PortalBackendKind): string[] {
  const source = kind === 'mysql' ? PORTAL_MYSQL_V5_SQL : PORTAL_SQLITE_V5_SQL
  const base = source.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(s => s && !s.startsWith('PRAGMA'))
  return [...base, ...portalV6Statements(kind), ...portalV7Statements(kind)]
}
/**
 * 受控定义的文本摘要 —— 迁移账本据此识别「这个库的结构是不是当前版本」。
 *
 * 🚨 **它必须随受控定义一起变**：只把 `PORTAL_SCHEMA_VERSION` 改大、
 *   而摘要还按旧文本算，会让已经迁到上一版的库**恰好**被判成 `current` ——
 *   闸门放行，然后看板查询撞上不存在的表，
 *   报错文案是「上报库不可用」，排查方向整个跑偏。
 *   所以这里把 v6 与 v7 的追加一并算进摘要。
 *
 * ⚠️ 摘要只覆盖 **DDL 文本**，不含权限行：权限是数据而不是结构，
 *   把它算进摘要会让「手工补了一条角色权限」把库判成「结构不符」。
 */
export function portalSchemaChecksum(kind: PortalBackendKind): string {
  const source = kind === 'mysql' ? PORTAL_MYSQL_V5_SQL : PORTAL_SQLITE_V5_SQL
  const additions = kind === 'mysql'
    ? `${PORTAL_MYSQL_V6_ADDITIONS}\n${PORTAL_MYSQL_V7_ADDITIONS}`
    : `${PORTAL_SQLITE_V6_ADDITIONS}\n${PORTAL_SQLITE_V7_ADDITIONS}`
  return createHash('sha256').update(`${source}\n${additions}`).digest('hex')
}
/**
 * ★ **已发布的 v6 摘要，冻结于此**（= v5 文本 + v6 追加，不含 v7）。
 *
 * 🚨 它的作用与 `portalSchemaChecksumV4` 完全一样：让**已经迁到 v6 的库**
 *   仍然能被认出来。`readPortalState()` 用它把这类库判成 `legacy`
 *   （「结构是上一版，但完整、可迁移」）。
 *
 * 不冻结的后果：那些库的账本里记的是「v6 摘要」，而 `portalSchemaChecksum()`
 *   现在返回「v7 摘要」，永远对不上 —— 它不再是「可迁移的起点」，
 *   而是 `unsupported`，即**服务端拒绝启动、迁移脚本也拒绝接手**。
 *   v7 是纯追加，这些库本来一条语句就能升上去，却会卡死在门口。
 *
 * ⚠️ v6 的两段文本一个字都不许再改：本函数按它们的**当前全文**求摘要，
 *   改动会立刻让所有 v6 库的账本摘要失配。
 */
export function portalSchemaChecksumV6(kind: PortalBackendKind): string {
  const source = kind === 'mysql' ? PORTAL_MYSQL_V5_SQL : PORTAL_SQLITE_V5_SQL
  const additions = kind === 'mysql' ? PORTAL_MYSQL_V6_ADDITIONS : PORTAL_SQLITE_V6_ADDITIONS
  return createHash('sha256').update(`${source}\n${additions}`).digest('hex')
}
