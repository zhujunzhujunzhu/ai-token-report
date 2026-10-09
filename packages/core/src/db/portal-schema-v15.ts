/**
 * v15：按小时 / 会话 / 原始维度折叠的看板查询表，以及事务内失效标记。
 * 不存金额。会话 ID 保留用于精确 DISTINCT；余数分布保留逐事件金额舍入。
 * 旧 v8 表保持原样，新表可完整重建，事实表的 INSERT/UPDATE/DELETE 同事务标记受影响小时。
 */
import type { PortalBackendKind } from './dialect.js'

export const PORTAL_V15_TABLES = ['usage_cube', 'usage_cube_dirty', 'usage_cube_meta'] as const
export const CUBE_TRIGGER_NAMES = ['usage_cube_insert', 'usage_cube_update', 'usage_cube_delete'] as const
export const CUBE_HOUR_INDEX = 'idx_usage_event_cube_hour'

export function cubeHourIndexSql(kind: PortalBackendKind): string {
  return `CREATE INDEX ${CUBE_HOUR_INDEX} ON usage_event (${cubeHourSql(kind, 'ts')})`
}

export function portalV15TableStatements(kind: PortalBackendKind): string[] {
  const mysql = kind === 'mysql'
  const text = (length: number) => mysql ? `VARCHAR(${length})` : 'TEXT'
  const integer = mysql ? 'BIGINT' : 'INTEGER'
  const end = mysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin' : ''
  const numbers = ['utc_hour', 'hour_of_day', 'day_kind', 'calls', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'lo', 'hi']
  return [
    `CREATE TABLE usage_cube (
  cube_id ${text(64)} NOT NULL PRIMARY KEY,
  day_key ${text(10)} NOT NULL,
  hour_key ${text(13)} NOT NULL,
  source ${text(32)} NOT NULL,
  member_id ${text(36)} NULL,
  user_id ${text(255)} NULL,
  user_name ${text(255)} NULL,
  provider ${text(255)} NOT NULL,
  model ${text(255)} NOT NULL,
  cwd TEXT NULL,
  session_id ${text(255)} NOT NULL,
  slot_key ${text(64)} NOT NULL,
  legacy_only ${integer} NOT NULL CHECK (legacy_only IN (0, 1)),
  remainders TEXT NOT NULL,
  ${numbers.map(name => `${name} ${integer} NOT NULL CHECK (${name} BETWEEN 0 AND 9007199254740991)`).join(',\n  ')},
  CHECK (hi >= lo)
)${end}`,
    `CREATE TABLE usage_cube_dirty (
  utc_hour ${integer} NOT NULL PRIMARY KEY CHECK (utc_hour BETWEEN 0 AND 9007199254740991)
)${end}`,
    `CREATE TABLE usage_cube_meta (
  id ${integer} NOT NULL PRIMARY KEY CHECK (id = 1),
  version_key ${text(255)} NOT NULL,
  updated_at_ms ${integer} NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991)
)${end}`,
    'CREATE INDEX idx_usage_cube_hour ON usage_cube (utc_hour)',
    'CREATE INDEX idx_usage_cube_member ON usage_cube (member_id, utc_hour)',
    'CREATE INDEX idx_usage_event_recent ON usage_event (ts, seq, event_id)',
    cubeHourIndexSql(kind),
  ]
}

/** 纯整数 UTC 小时编号不依赖 SQL 会话时区；展示时间键仍由 JS 生成。 */
export function cubeHourSql(kind: PortalBackendKind, ts: string): string {
  return kind === 'mysql' ? `(${ts} DIV 3600000)` : `(${ts} / 3600000)`
}

export function portalV15TriggerStatements(kind: PortalBackendKind): string[] {
  const mark = (record: 'OLD' | 'NEW') => {
    const value = cubeHourSql(kind, `${record}.ts`)
    return kind === 'mysql'
      ? `INSERT INTO usage_cube_dirty (utc_hour) VALUES (${value}) ON DUPLICATE KEY UPDATE utc_hour = ${value};`
      : `INSERT OR IGNORE INTO usage_cube_dirty (utc_hour) VALUES (${value});`
  }
  return [
    `CREATE TRIGGER usage_cube_insert AFTER INSERT ON usage_event FOR EACH ROW BEGIN ${mark('NEW')} END`,
    `CREATE TRIGGER usage_cube_update AFTER UPDATE ON usage_event FOR EACH ROW BEGIN ${mark('OLD')} ${mark('NEW')} END`,
    `CREATE TRIGGER usage_cube_delete AFTER DELETE ON usage_event FOR EACH ROW BEGIN ${mark('OLD')} END`,
  ]
}

export function portalV15Statements(kind: PortalBackendKind): string[] {
  return [...portalV15TableStatements(kind), ...portalV15TriggerStatements(kind)]
}
export function portalV15ChecksumInput(kind: PortalBackendKind): string {
  return portalV15Statements(kind).join(';\n')
}
