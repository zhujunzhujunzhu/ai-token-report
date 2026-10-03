/**
 * **来源日志根解析**：把「本机这次要读哪些来源、哪些根」收敛成一处。
 *
 * 为什么不能散在各处：DSH 有 `dshHomes`、Codex 有 `CODEX_HOME`、以后还有
 * Claude Code / WorkBuddy 各自的约定目录与开关。**每加一个来源就多一处
 * 「路径从哪来」的实现**，而路径解析的错法一律是「扫到 0 个文件」——
 * 它看起来与「这台机器确实没用过」完全一样。
 *
 * 因此这里的规则只有三条：
 *
 * 1. 根由**适配器**给（`adapter.roots(homes)`），本模块只负责顺序、去重与存在性；
 * 2. **不存在的根必须逐项报出**（`missing`），绝不静默 ——
 *    「配了但读不到」与「本来就没有」必须能分辨；
 * 3. 顺序**确定**：按来源 id 排序、次要副本（`secondary`，如 Codex 的
 *    `archived_sessions/`）排在主根之后。`event_id` 冲突时是「先到者胜」，
 *    顺序不稳定 = 同一批数据两次运行给出不同结果。
 */

import { existsSync } from 'node:fs'

import type { SessionSource } from '../types.js'
import { findSource, registeredSources, requireSource } from './registry.js'
import type { SourceRoot } from './types.js'

/** `0` / `false` / `no` / `off` 视为关闭（与 `home.ts` 的发现开关同一套写法）。 */
export function envFlagOff(value: string | undefined): boolean {
  const raw = value?.trim().toLowerCase()
  return raw === '0' || raw === 'false' || raw === 'no' || raw === 'off'
}

export interface SourceRootsOptions {
  /**
   * 只启用这些来源（缺省 = 全部已注册且未被开关关闭的来源）。
   *
   * ⚠️ 指定了**未注册**的来源必须抛错（见 {@link requireSource}）：
   *    「这个来源还没实现」与「这个来源没有用量」在输出上完全一样，
   *    静默给 0 条会让使用者以为「我这台机器没跑过 Claude Code」。
   */
  sources?: readonly SessionSource[]
  /**
   * 每个来源的**显式 home 列表**（覆盖该来源的默认解析）。
   *
   * 空数组/缺省 = 该来源按自己的默认规则解析（环境变量 > 约定目录）。
   */
  homes?: Partial<Record<SessionSource, readonly string[]>>
  /** 环境变量表（注入以便测试；缺省 `process.env`）。 */
  env?: Record<string, string | undefined>
  /** 目录是否存在（注入以便测试；缺省 `existsSync`）。 */
  exists?: (path: string) => boolean
}

export interface ResolvedSourceRoots {
  /** 实际存在的根（已排序、已按路径去重）。 */
  roots: SourceRoot[]
  /** 解析出来但**不存在**的根，逐项报出。 */
  missing: SourceRoot[]
  /** 实际启用的来源（顺序与 `roots` 的列举顺序一致）。 */
  sources: SessionSource[]
  /** 被环境开关关掉的来源（也要报出来：否则「没数据」分不清是关掉了还是没跑过）。 */
  disabled: SessionSource[]
}

/**
 * 解析本次要读的来源根。
 *
 * 顺序：来源 id 字典序 → 同一来源内主根在前、次要副本在后 → 路径去重（首次出现者胜）。
 */
export function resolveSourceRoots(options: SourceRootsOptions = {}): ResolvedSourceRoots {
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync

  const disabled: SessionSource[] = []
  let chosen: SessionSource[]
  if (options.sources !== undefined && options.sources.length > 0) {
    // 显式指定：未注册直接抛错（宁可失败，也不给一个「看起来正常」的空结果）
    for (const id of options.sources) requireSource(id)
    chosen = [...new Set(options.sources)]
  } else {
    chosen = []
    for (const adapter of registeredSources()) {
      if (adapter.disableEnv !== undefined && envFlagOff(env[adapter.disableEnv])) {
        disabled.push(adapter.id)
        continue
      }
      chosen.push(adapter.id)
    }
  }

  const candidates: SourceRoot[] = []
  for (const id of [...chosen].sort((a, b) => a.localeCompare(b))) {
    const adapter = findSource(id)
    if (adapter === null) continue
    const homes = options.homes?.[id] ?? []
    // 主根在前、次要副本在后：`event_id` 冲突时「先到者胜」必须可复现。
    const roots = adapter.roots(homes).filter((root) => root.source === id)
    candidates.push(...roots.filter((root) => root.secondary !== true), ...roots.filter((root) => root.secondary === true))
  }

  const seen = new Set<string>()
  const roots: SourceRoot[] = []
  const missing: SourceRoot[] = []
  for (const root of candidates) {
    // Windows 路径大小写不敏感：去重键要按平台归一，否则 `C:\x` 与 `c:\x` 会各算一个根。
    const key = process.platform === 'win32' ? root.path.toLowerCase() : root.path
    if (seen.has(key)) continue
    seen.add(key)
    if (exists(root.path)) roots.push(root)
    else missing.push(root)
  }

  const sources: SessionSource[] = []
  for (const root of roots) if (!sources.includes(root.source)) sources.push(root.source)
  return { roots, missing, sources, disabled }
}
