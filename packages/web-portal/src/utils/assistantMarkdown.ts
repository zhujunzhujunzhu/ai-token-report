/** 模型 Markdown 安全渲染：不执行原始 HTML、不加载图片，来源链接只接受绝对 HTTP(S)。 */
import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true, typographer: false })
// 仅识别带完整协议的来源，邮箱、裸域名和协议相对路径不自动变成链接。
markdown.linkify.set({ fuzzyLink: false, fuzzyEmail: false }).add('//', null)
const defaultLinkify = new MarkdownIt().linkify
for (const scheme of ['http:', 'https:']) markdown.linkify.add(scheme, {
  validate(text, pos) {
    // 默认解析器会把 user:password@host 截成 https://user；需先检查完整 authority。
    const authority = /^\/\/([^/?#\s<>]*)/.exec(text.slice(pos))?.[1]
    if (!authority || /[@\\]/.test(authority)) return 0
    return defaultLinkify.testSchemaAt(text, scheme, pos)
  },
})
// ★ 站内相对导航仍交给鉴权工具，公开来源仅在用户点击后于独立标签打开。
markdown.disable(['image'])
const originalValidate = markdown.validateLink.bind(markdown)
markdown.validateLink = value => {
  if (!originalValidate(value) || !/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value)) return false
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  } catch { return false }
}
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  const token = tokens[index]!
  token.attrSet('target', '_blank')
  token.attrSet('rel', 'noopener noreferrer')
  token.attrSet('referrerpolicy', 'no-referrer')
  return renderer.renderToken(tokens, index, options)
}
markdown.renderer.rules.table_open = () => '<div class="assistant-markdown-table"><table>'
markdown.renderer.rules.table_close = () => '</table></div>'
export function renderAssistantMarkdown(text: string): string { return markdown.render(text) }
