/**
 * 插件侧的路径解析 —— **唯一**把生效配置映射成路径的地方。
 *
 * ## 为什么要有这个文件
 *
 * 「身份文件在哪」这个问题在插件里有六个消费者：身份解析、设置页读写、
 * 上报 outbox、历史补报水位、统计库、以及诊断输出。它们各自
 * `resolvePaths(config.dshHome)` 过一次，就等于把「配置 → 路径」这件事
 * 实现了六遍 —— 少传一个字段不会编译失败，只会让**同一个配置对应两个不同的
 * 身份文件**（`index.ts` 里那条注释记的就是这个事故）。
 *
 * 所以：一律经这里取路径，函数只吃 `dshHomes` / `dshHome` / `dataDir` 三个字段。
 *
 * ## 会话日志根与数据目录是两件事
 *
 * | 取什么 | 由谁决定 | 换掉它的后果 |
 * |---|---|---|
 * | `sessionsRoots` | `dshHomes`（默认**自动发现**本机全部 DSH home） | 统计与历史补报改读另一组 home 的日志 |
 * | `identityPath` / `dbPath` / `outboxDir` / 补报水位 | `dataDir`（默认 `~/.ai-token-report`） | 换一份身份与本地库 |
 *
 * ★ 多套 DSH 并存时日志根**是一组**（`sessionsRoots`），而数据目录**只有一份**：
 *   库只有一份，统计才可能是一份并集。镜像会话靠 `event_id` 主键去重。
 *
 * ★ DSH Desktop 与命令行版 DSH 共用一份身份**不需要任何配置**：数据目录的默认值
 *   与 `dshHome` 无关，两套 DSH 天然指向同一个 `~/.ai-token-report`
 *   （见 `core/src/home.ts` 的文件头）。想刻意分开才显式给 `dataDir`
 *   或 `DSH_TOKEN_REPORT_DATA_DIR`。
 */

import { join, resolve } from 'node:path'

import { expandHomePath, resolvePaths, type ResolvedPaths } from '@ai-token-report/core'

import type { EffectiveConfig } from './config.js'

/**
 * 解析路径只需要这三个字段。
 *
 * 刻意收窄而不是吃整个 `EffectiveConfig`：这样「改路径的那些代码依赖了什么」
 * 在类型上一眼可见，也让浏览器半/测试可以只给这几项。
 */
export type PathConfig = Pick<EffectiveConfig, 'dshHome' | 'dshHomes' | 'dataDir'>

/**
 * 路径解析的入参。
 *
 * 收 `string` 是为了兼容「只有一个 home」的老调用点与老测试
 * （字符串一律按 `dshHome` 解释，与 core 的 `resolvePaths` 同义）。
 */
export type PathInput = string | PathConfig

/** 生效配置 → 全部路径。 */
export function reportPaths(config: PathInput = {}): ResolvedPaths {
  return resolvePaths(config)
}

/**
 * 磁盘 outbox 目录。
 *
 * `outbox.dir` 是**显式**配置项，所以在这里展开 `~` 并绝对化 ——
 * 文档示例里写的就是 `~/.ai-token-report/outbox`，而 `join()` 不会展开它，
 * 展开前那个「看起来对」的配置会在当前工作目录下建一个字面 `~` 目录。
 */
export function reportOutboxDir(config: EffectiveConfig): string {
  const dir = config.outbox.dir?.trim()
  return dir ? resolve(expandHomePath(dir)) : reportPaths(config).outboxDir
}

/**
 * 历史补报的水位目录。
 *
 * `scope` 由调用方算（端点 + 凭证 + 日志根的摘要）：换服务端或换日志根
 * 都要重新核对全部历史，所以作用域必须跟着这三个一起变。
 */
export function reportBackfillDir(config: PathConfig, scope: string): string {
  return join(reportPaths(config).dataDir, 'backfill', scope)
}