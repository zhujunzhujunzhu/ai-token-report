/**
 * **DSH 来源适配器** —— 把这套采集架子里「本来就有的那条路」包成适配器。
 *
 * ⚠️ 这里**不做任何解析**：列举复用 `scanner.ts` 的 `listSessionFiles()`，
 *   折叠复用它的 `eventCollector()`。包一层的目的只是让注册表能把它和
 *   Codex / Claude Code / WorkBuddy 一视同仁 —— **DSH 的行为一个字节都不许变**
 *   （`event_id` 仍是 `${sessionId}:${seq}`，不带来源前缀）。
 */

import { resolveDshHomes, resolveSessionsRoot } from '../home.js'
import { eventCollector, inspectSessionRoots, listSessionFiles } from '../scanner.js'
import type { SessionSourceAdapter, SourceRoot } from './types.js'

export const dshSource: SessionSourceAdapter = {
  id: 'dsh',
  encoding: 'zstd-frames',

  roots(homes) {
    // 空数组 = 调用方没显式指定 ⇒ 走既有的多 home 解析（环境变量 > 自动发现 > ~/.dsh）。
    const bases = homes.length > 0 ? [...homes] : resolveDshHomes()
    // 路径拼接走 `home.ts` 的那一处实现（`join()` 不展开 `~`，规则只能有一份）。
    return bases.map((home): SourceRoot => ({ path: resolveSessionsRoot(home), source: 'dsh' }))
  },

  async list(root, options = {}) {
    // 单根调用；多根合并的去重与顺序由上层（scanner）负责，语义与改动前完全一致。
    return listSessionFiles(root.path, options)
  },

  createFolder(meta, diagnostics, records) {
    // ★ 起始 cwd 取自 `meta.cwd`：增量块里通常没有 `session` 首行，
    //   而这个字段就是既有实现用来跨轮继承项目归属的那一个（别另起一套状态）。
    const state = { cwd: meta.cwd }
    const collector = eventCollector(meta, state, diagnostics, records)
    return {
      push: collector.push,
      finish() {
        collector.finish()
        meta.cwd = state.cwd
      },
    }
  },

  // DSH 的巡检保持原样（三层结构 + 帧选择规则），只是包成适配器的形状。
  async inspect(root) {
    const [info] = await inspectSessionRoots([root.path])
    if (info === undefined) return { sessions: 0, files: 0, latestMs: null }
    return {
      sessions: info.sessions,
      files: info.files,
      latestMs: info.latestMs,
      ...(info.error !== undefined ? { error: info.error } : {}),
    }
  },
}
