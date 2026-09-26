-- 数据库 v4 设计原型：只允许在全新隔离库执行，不是现网迁移脚本。
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
