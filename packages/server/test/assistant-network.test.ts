/** 联网校验必须发生在传输之前，也覆盖重定向和 DNS 地址切换。 */
import { expect, test } from 'bun:test'
import { AssistantNetwork, isPublicAddress, publicWebUrl, webText } from '../src/assistant/network.js'
test('回环、保留、映射IPv6与内网地址不能请求', () => {
  for (const ip of ['127.0.0.1', '10.1.1.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.1.1', '198.18.0.1', '::1', '::ffff:8.8.8.8', 'fe80::1', 'fc00::1', '2001:db8::1']) expect(isPublicAddress(ip)).toBe(false)
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPublicAddress(ip)).toBe(true)
  for (const url of ['file:///etc/passwd', 'http://2130706433/', 'http://localhost/', 'https://user:secret@example.org', 'https://example.org:8787', 'http://a.internal/']) expect(() => publicWebUrl(url)).toThrow()
})
test('域名解析任意一条地址为私网即拒绝，不建连', async () => {
  let calls = 0
  const network = new AssistantNetwork(async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }], async () => { calls++; throw new Error('不能调用') })
  await expect(network.read('https://example.org/', new AbortController().signal)).rejects.toThrow('内网')
  expect(calls).toBe(0)
})
test('公开链接重定向到私网不访问第二跳', async () => {
  let calls = 0
  const network = new AssistantNetwork(async () => [{ address: '8.8.8.8', family: 4 }], async (_url, ip) => {
    calls++; expect(ip.address).toBe('8.8.8.8')
    return { status: 302, location: 'http://169.254.169.254/latest/', contentType: 'text/plain', body: '', truncated: false }
  })
  await expect(network.read('https://example.org/', new AbortController().signal)).rejects.toThrow('保留')
  expect(calls).toBe(1)
})
test('搜索返回公开来源，不执行网页脚本并明确外部内容', async () => {
  const network = new AssistantNetwork(async () => [{ address: '8.8.8.8', family: 4 }], async () => ({
    status: 200, contentType: 'application/rss+xml', body: '<rss><item><title>官方 &amp; 文档</title><link>https://example.org/docs</link><description><![CDATA[<p>说明</p><script>steal()</script>]]></description></item></rss>', truncated: false,
  }))
  const results = await network.search('模型文档', new AbortController().signal)
  expect(results.results[0]).toEqual({ title: '官方 & 文档', url: 'https://example.org/docs', snippet: '说明' })
  expect(results.untrusted_web_content).toBe(true)
  expect(webText('<p>正文</p><script>bad()</script><style>body{}</style>')).toBe('正文')
})
test('取消不触发网络并限制响应大小', async () => {
  const network = new AssistantNetwork(async () => [{ address: '8.8.8.8', family: 4 }], async () => ({ status: 200, contentType: 'text/plain', body: 'a'.repeat(25_000), truncated: false }))
  expect((await network.read('https://example.org', new AbortController().signal)).truncated).toBe(true)
  await expect(network.read('https://example.org', AbortSignal.abort())).rejects.toThrow()
  await expect(network.search('', new AbortController().signal)).rejects.toThrow()
})
test('DNS悬挂也响应取消，不会等待解析完才停止', async () => {
  const network = new AssistantNetwork(() => new Promise(() => {}), async () => { throw new Error('不能建连') })
  const controller = new AbortController()
  const pending = network.read('https://example.org', controller.signal)
  controller.abort(new Error('用户停止'))
  await expect(pending).rejects.toThrow('用户停止')
})
