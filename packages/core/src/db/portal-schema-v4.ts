/** 上报库 v4 的可打包 SQL 真源；契约测试逐字校验 docs/database-v4，发布产物无需读取 docs。 */
import { createHash } from 'node:crypto'
import type { PortalBackendKind } from './dialect.js'
export const PORTAL_SCHEMA_VERSION = 4
export const PORTAL_SQLITE_V4_SQL = `-- 数据库 v4 设计原型：只允许在全新隔离库执行，不是现网迁移脚本。
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

CREATE TABLE departments (
  department_id TEXT NOT NULL PRIMARY KEY CHECK ((length(department_id) = 36 AND substr(department_id,9,1) = '-' AND substr(department_id,14,1) = '-' AND substr(department_id,19,1) = '-' AND substr(department_id,24,1) = '-' AND length(replace(department_id,'-','')) = 32 AND replace(department_id,'-','') NOT GLOB '*[^0-9a-f]*')),
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
  department_id TEXT NULL CHECK (department_id IS NULL OR (length(department_id) = 36 AND substr(department_id,9,1) = '-' AND substr(department_id,14,1) = '-' AND substr(department_id,19,1) = '-' AND substr(department_id,24,1) = '-' AND length(replace(department_id,'-','')) = 32 AND replace(department_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK ((typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991)),
  created_at_ms INTEGER NOT NULL CHECK ((typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991)),
  updated_at_ms INTEGER NOT NULL CHECK ((typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991)),
  CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (department_id) REFERENCES departments(department_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_members_department ON members (department_id);
CREATE INDEX idx_members_status ON members (status);

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
  dept TEXT NULL CHECK (dept IS NULL OR length(dept) BETWEEN 1 AND 255),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK ((typeof(input_tokens) = 'integer' AND input_tokens BETWEEN 0 AND 9007199254740991)),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK ((typeof(output_tokens) = 'integer' AND output_tokens BETWEEN 0 AND 9007199254740991)),
  cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK ((typeof(cache_read_tokens) = 'integer' AND cache_read_tokens BETWEEN 0 AND 9007199254740991)),
  cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK ((typeof(cache_write_tokens) = 'integer' AND cache_write_tokens BETWEEN 0 AND 9007199254740991)),
  reasoning_tokens INTEGER NOT NULL DEFAULT 0 CHECK ((typeof(reasoning_tokens) = 'integer' AND reasoning_tokens BETWEEN 0 AND 9007199254740991)),
  turn INTEGER NULL CHECK (turn IS NULL OR (typeof(turn) = 'integer' AND turn BETWEEN -9007199254740991 AND 9007199254740991)),
  step INTEGER NULL CHECK (step IS NULL OR (typeof(step) = 'integer' AND step BETWEEN -9007199254740991 AND 9007199254740991)),
  member_id TEXT NULL CHECK (member_id IS NULL OR (length(member_id) = 36 AND substr(member_id,9,1) = '-' AND substr(member_id,14,1) = '-' AND substr(member_id,19,1) = '-' AND substr(member_id,24,1) = '-' AND length(replace(member_id,'-','')) = 32 AND replace(member_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  department_id TEXT NULL CHECK (department_id IS NULL OR (length(department_id) = 36 AND substr(department_id,9,1) = '-' AND substr(department_id,14,1) = '-' AND substr(department_id,19,1) = '-' AND substr(department_id,24,1) = '-' AND length(replace(department_id,'-','')) = 32 AND replace(department_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  report_token_id TEXT NULL CHECK (report_token_id IS NULL OR (length(report_token_id) = 36 AND substr(report_token_id,9,1) = '-' AND substr(report_token_id,14,1) = '-' AND substr(report_token_id,19,1) = '-' AND substr(report_token_id,24,1) = '-' AND length(replace(report_token_id,'-','')) = 32 AND replace(report_token_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  received_at_ms INTEGER NULL CHECK (received_at_ms IS NULL OR (typeof(received_at_ms) = 'integer' AND received_at_ms BETWEEN 0 AND 9007199254740991)),
  FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (department_id) REFERENCES departments(department_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
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
CREATE INDEX idx_usage_event_department_ts ON usage_event (department_id, ts);
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
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000110','departments:read','departments:read',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000111','departments:manage','departments:manage',0);
INSERT INTO role_permissions (role_id,permission_id) SELECT '00000000-0000-4000-8000-000000000001',permission_id FROM permissions;
INSERT INTO role_permissions (role_id,permission_id) SELECT '00000000-0000-4000-8000-000000000002',permission_id FROM permissions WHERE code IN ('identity:read','usage:write','stats:read','departments:read');
INSERT INTO portal_identity_state (state_id,singleton_key,revision,updated_at_ms) VALUES ('00000000-0000-4000-8000-000000000003',1,0,0);
-- 迁移记录由执行器在核实 DDL 后写入真实 checksum；本文件不伪造迁移完成证据。
-- 此设计不创建本地扫描的 file_watermark/session_state，也不重定义 ingest_run。
`
export const PORTAL_MYSQL_V4_SQL = `-- 数据库 v4 设计原型：只允许在全新隔离库执行，不是现网迁移脚本。
-- 不执行 ALTER/DROP，不修改本地 usage.sqlite 的 schema v3。
-- 部署前必须另行实现带备份、版本闸门与恢复点的生产迁移。
-- UUID 使用小写标准格式；旧 event_id/session_id/user_id 保持原语义。
-- 所有时间为 epoch 毫秒；所有数值不超过 JavaScript 安全整数上限。
-- token/session/binding 仅存 32 字节摘要的 64 位十六进制串。
-- 验证码答案存 HMAC-SHA256，密钥由部署环境提供，绝不保存四位答案或裸 SHA256。
-- 密码哈希复用带算法/版本/盐的编码；数据库不生成、不存明文密码。
-- 历史引用全部 RESTRICT，不以删除人员/令牌清除历史。
-- 目标 MySQL 8.4；InnoDB/utf8mb4_0900_bin（NO PAD），原始事件键不 trim。

CREATE TABLE departments (
  department_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (department_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
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
  department_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL CHECK (department_id IS NULL OR department_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','archived')),
  version BIGINT NOT NULL DEFAULT 1 CHECK ((version BETWEEN 1 AND 9007199254740991)),
  created_at_ms BIGINT NOT NULL CHECK ((created_at_ms BETWEEN 0 AND 9007199254740991)),
  updated_at_ms BIGINT NOT NULL CHECK ((updated_at_ms BETWEEN 0 AND 9007199254740991)),
  CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (department_id) REFERENCES departments(department_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX idx_members_department ON members (department_id);
CREATE INDEX idx_members_status ON members (status);

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
  dept VARCHAR(255) NULL CHECK (dept IS NULL OR CHAR_LENGTH(dept) BETWEEN 1 AND 255),
  input_tokens BIGINT NOT NULL DEFAULT 0 CHECK ((input_tokens BETWEEN 0 AND 9007199254740991)),
  output_tokens BIGINT NOT NULL DEFAULT 0 CHECK ((output_tokens BETWEEN 0 AND 9007199254740991)),
  cache_read_tokens BIGINT NOT NULL DEFAULT 0 CHECK ((cache_read_tokens BETWEEN 0 AND 9007199254740991)),
  cache_write_tokens BIGINT NOT NULL DEFAULT 0 CHECK ((cache_write_tokens BETWEEN 0 AND 9007199254740991)),
  reasoning_tokens BIGINT NOT NULL DEFAULT 0 CHECK ((reasoning_tokens BETWEEN 0 AND 9007199254740991)),
  turn BIGINT NULL CHECK (turn IS NULL OR (turn BETWEEN -9007199254740991 AND 9007199254740991)),
  step BIGINT NULL CHECK (step IS NULL OR (step BETWEEN -9007199254740991 AND 9007199254740991)),
  member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL CHECK (member_id IS NULL OR member_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  department_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL CHECK (department_id IS NULL OR department_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  report_token_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL CHECK (report_token_id IS NULL OR report_token_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  received_at_ms BIGINT NULL CHECK (received_at_ms IS NULL OR (received_at_ms BETWEEN 0 AND 9007199254740991)),
  FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (department_id) REFERENCES departments(department_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
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
CREATE INDEX idx_usage_event_department_ts ON usage_event (department_id, ts);
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
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000110','departments:read','departments:read',0);
INSERT INTO permissions (permission_id,code,description,created_at_ms) VALUES ('00000000-0000-4000-8000-000000000111','departments:manage','departments:manage',0);
INSERT INTO role_permissions (role_id,permission_id) SELECT '00000000-0000-4000-8000-000000000001',permission_id FROM permissions;
INSERT INTO role_permissions (role_id,permission_id) SELECT '00000000-0000-4000-8000-000000000002',permission_id FROM permissions WHERE code IN ('identity:read','usage:write','stats:read','departments:read');
INSERT INTO portal_identity_state (state_id,singleton_key,revision,updated_at_ms) VALUES ('00000000-0000-4000-8000-000000000003',1,0,0);
-- 迁移记录由执行器在核实 DDL 后写入真实 checksum；本文件不伪造迁移完成证据。
-- 此设计不创建本地扫描的 file_watermark/session_state，也不重定义 ingest_run。
`
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

/** 设计 SQL 没有触发器或字符串内分号；只在本模块的受控 SQL 上拆句。 */
export function portalSchemaStatements(kind: PortalBackendKind): string[] {
  const source = kind === 'mysql' ? PORTAL_MYSQL_V4_SQL : PORTAL_SQLITE_V4_SQL
  return source.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(s => s && !s.startsWith('PRAGMA'))
}
export function portalSchemaChecksum(kind: PortalBackendKind): string {
  return createHash('sha256').update(kind === 'mysql' ? PORTAL_MYSQL_V4_SQL : PORTAL_SQLITE_V4_SQL).digest('hex')
}
