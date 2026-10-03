/**
 * 来源注册表：**「本机支持哪些来源」的唯一真源**。
 *
 * 为什么要有它（而不是在 scanner 里 `if (kind === 'codex')`）：
 * 每加一个客户端就改一次 scanner，等于把「扩展点」散在一个会越来越长的分支里；
 * 而下游（水位线 / 幂等键 / 入库 / 上报 / 计价）本来就不该知道来源的存在。
 *
 * 注册表一旦没有某个 id 的适配器，调用方必须**明确报错**（见 {@link requireSource}），
 * 绝不能静默返回 0 条 —— 「这个来源还没实现」与「这个来源没有用量」
 * 在输出上完全一样，是这类多来源系统里最容易骗过人的一种失败。
 */

import type { SessionSource } from '../types.js'
import { claudeCodeSource } from './claude-code.js'
import { codexSource } from './codex.js'
import { dshSource } from './dsh.js'
import { traeCnSource, traeSource } from './trae.js'
import type { SessionSourceAdapter } from './types.js'
import { workbuddySource } from './workbuddy.js'

const registry = new Map<SessionSource, SessionSourceAdapter>()

/** 注册一个来源适配器。同一 id 重复注册会覆盖（便于测试注入）。 */
export function registerSource(adapter: SessionSourceAdapter): void {
  registry.set(adapter.id, adapter)
}

/** 取一个来源适配器；未注册返回 `null`。 */
export function findSource(id: SessionSource): SessionSourceAdapter | null {
  return registry.get(id) ?? null
}

/** 取一个来源适配器；未注册直接抛错（用于「用户显式指定了来源」的路径）。 */
export function requireSource(id: SessionSource): SessionSourceAdapter {
  const adapter = findSource(id)
  if (adapter === null) throw new Error(`没有注册来源适配器：${id}`)
  return adapter
}

/** 已注册的全部来源（顺序固定，便于输出稳定）。 */
export function registeredSources(): SessionSourceAdapter[] {
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id))
}

// ── 内置来源：新增一个客户端就在这里加一行 ────────────────────────────────
registerSource(dshSource)
registerSource(codexSource)
registerSource(claudeCodeSource)
// Trae 是**两个**来源：国际版与国内版是两套独立安装、两套账号与两套模型族，
// 合并采集之后就再也分不开「这个数字是谁的」（见 `sources/trae.ts` 文件头）。
registerSource(traeSource)
registerSource(traeCnSource)
// WorkBuddy（腾讯）没有发行版之分：一个 id 就够（与 Trae 那条「两个发行版 = 两个来源」相对）。
registerSource(workbuddySource)
