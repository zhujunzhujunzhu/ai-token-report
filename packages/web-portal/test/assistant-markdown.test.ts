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
test('原始HTML与图片不执行，危险协议及任意站内相对导航不可点击', () => {
  const html = renderAssistantMarkdown('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n\n[点击](javascript:alert(1))\n[数据](data:text/html,test)\n[相对](/members)\n[协议相对](//example.com/x)\n[凭证](https://user:secret@example.com)\n![图片](javascript:alert(1))')
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('<img')
  expect(html).not.toContain('<a ')
  expect(html).toContain('&lt;script&gt;')
})
test('公开HTTP(S)来源链接可点击且独立打开，不发送后台页面来源', () => {
  const html = renderAssistantMarkdown('[官方资料](https://example.com/docs?q=%22value%22)\n<http://example.com/reference>')
  expect(html).toContain('href="https://example.com/docs?q=%22value%22"')
  expect(html).toContain('href="http://example.com/reference"')
  expect(html).toContain('target="_blank"')
  expect(html).toContain('rel="noopener noreferrer"')
  expect(html).toContain('referrerpolicy="no-referrer"')
})

test('裸HTTP(S)网址可点击，邮箱和危险/相对来源不自动链接', () => {
  const html = renderAssistantMarkdown('来源：https://example.com/docs?q=usage\nhttp://example.com/reference')
  expect(html).toContain('href="https://example.com/docs?q=usage"')
  expect(html).toContain('href="http://example.com/reference"')
  expect(html).toContain('rel="noopener noreferrer"')
  for (const text of ['test@example.com', 'mailto:test@example.com', 'ftp://example.com/report', 'https://user:secret@example.com', '//example.com/relative', '/members', 'example.com/path', 'javascript:alert(1)', 'data:text/html,test']) {
    expect(renderAssistantMarkdown(text)).not.toContain('<a ')
  }
})
test('来源文本和标题均转义，不能注入事件属性或原始标签', () => {
  const html = renderAssistantMarkdown('[<img onerror=alert(1)>](https://example.com "\" onclick=\"alert(1)")\nhttps://example.com/pixel\n![不可自动加载](https://example.com/pixel)')
  expect(html).not.toContain('<img')
  expect(html).not.toContain('<script')
  expect(html).not.toContain(' onclick="')
})
