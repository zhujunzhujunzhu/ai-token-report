/** 模型富文本必须展示表格、列表与代码，同时不执行 HTML 或发出远程资源请求。 */
import { expect, test } from 'bun:test'
import { renderAssistantMarkdown } from '../src/utils/assistantMarkdown.js'

test('Markdown 标题、列表、表格及代码块按语法渲染', () => {
  const html = renderAssistantMarkdown('## 用量分析\n\n- **缓存读**是独立项\n\n| 模型 | Token |\n| --- | ---: |\n| DSH | 42 |\n\n```json\n{"calls":2}\n```')
  expect(html).toContain('<h2>用量分析</h2>')
  expect(html).toContain('<strong>缓存读</strong>')
  expect(html).toContain('<table>')
  expect(html).toContain('assistant-markdown-table')
  expect(html).toContain('<pre><code')
})
test('原始 HTML、危险链接、自动链接和图片均不会变成可执行或远程元素', () => {
  const html = renderAssistantMarkdown('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n\n[点击](javascript:alert(1))\n[点击](https://example.com)\n![图片](https://example.com/pixel)\n<https://example.com>')
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('<img')
  expect(html).not.toContain('<a ')
  expect(html).toContain('&lt;script&gt;')
})
