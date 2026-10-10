/** 公开网页工具：固定解析出的公网 IP 建连，重定向逐跳校验，不携带登录信息。 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { IdentityError } from '../identity/types.js'

const bad = (message: string): never => { throw new IdentityError(400, message) }
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a! >= 224 || (a === 100 && b! >= 64 && b! <= 127)
      || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99) || (b === 2)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113))
  }
  if (isIP(address) !== 6) return false
  // ★ 只允许全球单播，屏蔽 IPv4 映射、NAT64、链路本地、ULA 和隧道地址。
  const text = address.toLowerCase()
  const segments = text.split(':')
  return /^[23][0-9a-f]{3}:/.test(text) && !(segments[0] === '2001' && (parseInt(segments[1] || '0', 16) < 0x200 || segments[1] === 'db8')) && !/^(2002:|3fff:)/.test(text)
}
export function publicWebUrl(raw: string): URL {
  if (raw.length > 2048) return bad('网页地址过长')
  let url: URL
  try { url = new URL(raw) } catch { return bad('请输入完整的公开网页地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80'))) return bad('仅支持无凭据、标准端口的 HTTP(S) 网页')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host.includes('.') && !isIP(host)) return bad('不能访问内部主机')
  if (host === 'localhost' || /\.(?:localhost|local|internal|lan|home|test|invalid)$/.test(host) || (isIP(host) && !isPublicAddress(host))) return bad('不能访问内网、回环或保留地址')
  url.hash = ''
  return url
}
export interface WebDocument { url: string; content_type: string; text: string; truncated: boolean }
interface WebResponse { status: number; location?: string; contentType: string; body: string; truncated: boolean }
export type WebResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>
export type WebTransport = (url: URL, address: { address: string; family: number }, signal: AbortSignal) => Promise<WebResponse>
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) abort()
  })
}
const transport: WebTransport = (url, address, signal) => new Promise((resolve, reject) => {
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    signal, agent: false, family: address.family,
    // ★ DNS 校验和建连使用同一个地址，阻止两次解析之间切换到私网。
    lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
    headers: { 'User-Agent': 'AI-Token-Assistant/1.0', Accept: 'text/html,text/plain,application/xml,application/rss+xml', 'Accept-Encoding': 'identity' },
  }, response => {
    const contentType = String(response.headers['content-type'] ?? '').toLowerCase()
    const status = response.statusCode ?? 502
    if (status >= 300 && status < 400) {
      response.resume()
      resolve({ status, location: response.headers.location, contentType, body: '', truncated: false })
      return
    }
    if (!/^(text\/(?:html|plain|xml)|application\/(?:xml|rss\+xml|json))/.test(contentType) || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
      response.destroy()
      reject(new IdentityError(400, '网页需要是未压缩的 HTML、文本或 XML，不能读取二进制文件'))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (truncated: boolean) => {
      if (settled) return
      settled = true
      resolve({ status, contentType, body: Buffer.concat(chunks).toString('utf8'), truncated })
    }
    response.on('data', (chunk: Buffer) => {
      const remaining = 512_000 - size
      chunks.push(chunk.subarray(0, Math.max(remaining, 0))); size += chunk.length
      if (size >= 512_000) { finish(true); response.destroy() }
    })
    response.on('end', () => finish(false))
    response.on('error', error => { if (!settled) reject(error) })
  })
  request.on('error', reject)
  request.end()
})
export function decodeWebEntities(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (all, value: string) => {
      const code = value[0]?.toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value)
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : all
    }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_all, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name]!)
}
export function webText(html: string): string {
  return decodeWebEntities(html.replace(/<(script|style|noscript|svg|iframe|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<\/(?:p|div|h[1-6]|li|tr|section|article)>/gi, '\n').replace(/<[^>]*>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
}
export class AssistantNetwork {
  constructor(private resolver: WebResolver = host => lookup(host, { all: true }), private fetcher: WebTransport = transport) {}
  async read(raw: string, signal: AbortSignal): Promise<WebDocument> {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(12_000)])
    let url = publicWebUrl(raw)
    for (let hop = 0; hop < 4; hop++) {
      combined.throwIfAborted()
      const host = url.hostname.replace(/^\[|\]$/g, '')
      const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await abortable(this.resolver(host), combined)
      combined.throwIfAborted()
      if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) return bad('网页域名解析到内网或保留地址')
      const response = await this.fetcher(url, addresses[0]!, combined)
      if (response.status >= 300 && response.status < 400 && response.location) { url = publicWebUrl(new URL(response.location, url).toString()); continue }
      if (response.status < 200 || response.status >= 300) throw new IdentityError(502, '公开网页返回错误，请更换来源')
      const text = /xml|rss/.test(response.contentType) ? response.body : webText(response.body)
      return { url: url.toString(), content_type: response.contentType, text: text.slice(0, 24_000), truncated: response.truncated || text.length > 24_000 }
    }
    return bad('网页重定向过多')
  }
  async search(query: string, signal: AbortSignal) {
    if (!query.trim() || query.length > 300 || /[\u0000-\u001f]/.test(query)) return bad('搜索词需要为 1～300 个字符')
    const url = new URL('https://www.bing.com/search')
    url.searchParams.set('q', query.trim()); url.searchParams.set('format', 'rss')
    const document = await this.read(url.toString(), signal)
    const results = [...document.text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0, 6).flatMap(match => {
      const field = (name: string) => decodeWebEntities(match[1]!.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>', 'i'))?.[1] ?? '').trim()
      try { const link = publicWebUrl(field('link')); return [{ title: webText(field('title')).slice(0, 200), url: link.toString(), snippet: webText(field('description')).slice(0, 1000) }] }
      catch { return [] }
    })
    if (!results.length) throw new IdentityError(502, '公开搜索暂未返回结果，请提供官网链接后读取')
    return { query: query.trim(), results, source: 'Bing RSS', captured_at_ms: Date.now(), untrusted_web_content: true }
  }
}
