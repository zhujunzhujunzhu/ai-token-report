/**
 * 契约单一真源 —— 前后端与插件都从这里 import。
 *
 * 入口刻意保持极简：`export *` 三个模块，避免使用方记路径。
 */

export * from './identity.js'
export * from './metrics.js'
export * from './price.js'
export * from './protocol.js'
export * from './portal-identity.js'
// 服务端根地址的归一化（插件面板 / 本地页配置 / CLI 部署参数共用一份实现）
export * from './portal-url.js'
