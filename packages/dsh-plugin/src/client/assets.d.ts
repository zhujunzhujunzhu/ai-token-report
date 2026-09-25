/** 样式以文本打入插件 JS，DSH 不提供独立 CSS 文件加载入口。 */
declare module '*.css' { const css: string; export default css }
