/**
 * 契约单一真源 —— 前后端与插件都从这里 import。
 *
 * 入口刻意保持极简：`export *` 三个模块，避免使用方记路径。
 */

export * from './identity.js'
export * from './metrics.js'
export * from './protocol.js'