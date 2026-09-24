/**
 * DSH home 与会话日志目录定位。
 *
 * 优先级：显式参数 > `DSH_HOME` 环境变量 > `~/.dsh`。
 *
 * S1 阶段从 `dsh-token-stats/src/home.ts` 原样迁入，行为不变。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveDshHome(explicit?: string): string {
  if (explicit) return explicit
  const fromEnv = process.env['DSH_HOME']
  if (fromEnv) return fromEnv
  return join(homedir(), '.dsh')
}

export function resolveSessionsRoot(dshHome: string): string {
  return join(dshHome, 'sessions')
}

export interface ResolvedPaths {
  dshHome: string
  sessionsRoot: string
  /** 本地身份文件路径（`$DSH_HOME/token-report/identity.json`）。 */
  identityPath: string
  /** 本地 SQLite 增量库路径（`$DSH_HOME/token-report/usage.sqlite`）。 */
  dbPath: string
  /** 上报水位线状态文件（`$DSH_HOME/token-report/state.json`）。 */
  statePath: string
  /**
   * 插件磁盘 outbox 目录（`$DSH_HOME/token-report/outbox`）。
   *
   * CLI 的上报靠 `state.json` 里的 `pending` 保命，而 DSH 插件的上报走
   * **一批一个文件**的 outbox（见 `dsh-plugin/src/outbox.ts`）。
   * 两者刻意不共用目录：同名文件混在一起时，任何一方清理都会误删另一方。
   */
  outboxDir: string
  sessionsRootExists: boolean
}

export function resolvePaths(explicitHome?: string): ResolvedPaths {
  const dshHome = resolveDshHome(explicitHome)
  const sessionsRoot = resolveSessionsRoot(dshHome)
  return {
    dshHome,
    sessionsRoot,
    identityPath: join(dshHome, 'token-report', 'identity.json'),
    // 与 state.json / identity.json 同目录：都是「本机 token-report 的长期状态」，
    // 用户清空 home 时应当一起被清掉，分散到别处会留下孤儿文件。
    //
    // ⚠️ 文件名**内联**而不 import `db/schema.ts` 的 `dbFileName()`：
    //   那个模块 import 了 `bun:sqlite`，而 home.ts 会被 web / 插件侧
    //   间接引用。为一行字符串在路径解析模块里拖进整个数据库依赖，
    //   是让「只想要 sessionsRoot」的调用方也背上 sqlite 的代价。
    dbPath: join(dshHome, 'token-report', 'usage.sqlite'),
    statePath: join(dshHome, 'token-report', 'state.json'),
    outboxDir: join(dshHome, 'token-report', 'outbox'),
    sessionsRootExists: existsSync(sessionsRoot),
  }
}