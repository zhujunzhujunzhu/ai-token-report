/** 模型 Markdown 的安全渲染：关闭原始 HTML、图片及外链，防止执行代码或远程追踪。 */
import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: false, typographer: false })
// ★ 链接保留可读文字，页面跳转统一交给受权限限制的 portal_navigate。
markdown.disable(['image', 'link', 'autolink'])
markdown.renderer.rules.table_open = () => '<div class="assistant-markdown-table"><table>'
markdown.renderer.rules.table_close = () => '</table></div>'
export function renderAssistantMarkdown(text: string): string { return markdown.render(text) }
