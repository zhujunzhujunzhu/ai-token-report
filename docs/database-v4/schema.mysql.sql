-- 数据库 v4 设计原型：只允许在全新隔离库执行，不是现网迁移脚本。
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
