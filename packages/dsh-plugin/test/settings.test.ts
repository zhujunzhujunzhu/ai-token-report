/** 配置保存守住服务端身份边界、凭证不回显与失败不覆盖。 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readIdentity, resolvePaths } from '@ai-token-report/core'
import { resolveConfig } from '../src/config.js'
import {
  baseUrlOf, createSettingsHandler, endpointOf, normalizeBaseUrl, readConnection, withSavedConnection,
} from '../src/settings.js'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'atr-settings-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })
const baseUrl = 'http://127.0.0.1:8787'
const endpoint = 'http://127.0.0.1:8787/api/v1/token-usage'
function request(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/tokenReport.settings', { method: 'POST', body: JSON.stringify(body) })
}
function handler(result: unknown, locked = false, seen?: string[]) {
  return createSettingsHandler(resolveConfig({ dshHome: home }), {
    locked,
    fetchImpl: async (url) => { seen?.push(String(url)); return Response.json(result) },
  })
}
test('保存 appKey 与地址，GET 不回传任何 Key，重启后连接可恢复', async () => {
  const seen: string[] = []
  const run = handler({ ok: true, name: '服务端姓名', dept: '研发' }, false, seen)
  const response = await run(request({ baseUrl, appKey: 'report-secret' }))
  expect(await response.json()).toMatchObject({ ok: true, name: '服务端姓名', restartRequired: true })
  // ★ 校验地址由 baseUrl 推导，用户不需要自己拼 /api/v1/identity/verify
  expect(seen).toEqual(['http://127.0.0.1:8787/api/v1/identity/verify'])
  // ★ token 就是 appKey：本地页与 CLI 读同一份身份文件
  expect(readIdentity(resolvePaths(home).identityPath).identity).toMatchObject({ name: '服务端姓名', token: 'report-secret', dept: '研发' })
  const text = await (await run(new Request('http://localhost/api/tokenReport.settings'))).text()
  expect(text).not.toContain('report-secret')
  expect(JSON.parse(text)).toMatchObject({ signed: true, name: '服务端姓名', baseUrl })
  expect(withSavedConnection({ dshHome: home })).toMatchObject({ endpoint, appKey: 'report-secret' })
  expect(withSavedConnection({ dshHome: home, appKey: 'deployment-key' }).appKey).toBe('report-secret')
})
test('缺服务端姓名的成功响应不能退回客户端提交内容', async () => {
  const response = await handler({ ok: true })(request({ baseUrl, appKey: 'secret' }))
  expect(await response.json()).toMatchObject({ ok: false })
  expect(readIdentity(resolvePaths(home).identityPath).identity).toBeNull()
  expect(readConnection(home)).toEqual({})
})
test('验证失败保留原配置，部署锁定时不保存', async () => {
  await handler({ ok: true, name: '原署名' })(request({ baseUrl, appKey: 'old' }))
  const response = await handler({ ok: false, reason: 'Key 无效' })(request({ baseUrl, appKey: 'new' }))
  expect(await response.json()).toMatchObject({ reason: 'Key 无效' })
  expect(readConnection(home).appKey).toBe('old')
  expect(readIdentity(resolvePaths(home).identityPath).identity?.name).toBe('原署名')
  const locked = await handler({ ok: true, name: '新姓名' }, true)(request({ baseUrl, appKey: 'new' }))
  expect(await locked.json()).toMatchObject({ ok: false })
})
test('地址与凭证缺失都在本地就拦下，不发任何校验请求', async () => {
  const seen: string[] = []
  const run = handler({ ok: true, name: '不该被用到' }, false, seen)
  expect(await (await run(request({ baseUrl, appKey: '   ' }))).json()).toMatchObject({ ok: false })
  expect(await (await run(request({ baseUrl: 'ftp://nope', appKey: 'k' }))).json()).toMatchObject({ ok: false })
  expect(seen).toEqual([])
})
test('不把校验请求重定向到其它地址，网络错误不回显凭证', async () => {
  const run = createSettingsHandler(resolveConfig({ dshHome: home }), { fetchImpl: async (_url, init) => {
    expect(init?.redirect).toBe('error')
    throw new Error('secret-key')
  } })
  const result = await run(request({ baseUrl, appKey: 'secret-key' }))
  expect(await result.text()).not.toContain('secret-key')
  expect(readConnection(home)).toEqual({})
})
test('旧版只存 endpoint 的配置仍可读，升级后不必重填', async () => {
  mkdirSync(join(home, 'token-report'), { recursive: true })
  writeFileSync(join(home, 'token-report', 'plugin-connection.json'), JSON.stringify({ endpoint, appKey: 'legacy' }))
  expect(readConnection(home)).toEqual({ baseUrl, appKey: 'legacy' })
  // 旧文件只有连接、没有身份：面板应回填地址并如实说「未署名」，而不是地址空着要人重填
  expect(await (await handler({ ok: true, name: '旧配置' })(new Request('http://localhost/api/tokenReport.settings'))).json())
    .toMatchObject({ baseUrl, signed: false, hasAppKey: true })
})
test('地址归一：接受完整上报地址与末尾斜杠，拒绝带账号或查询串', () => {
  expect(normalizeBaseUrl('http://127.0.0.1:8787/')).toBe(baseUrl)
  expect(normalizeBaseUrl(endpoint)).toBe(baseUrl)
  expect(normalizeBaseUrl('http://127.0.0.1:8787/api/v1')).toBe(baseUrl)
  // 反向代理挂在子路径下时必须保留前缀，否则会把合法部署改写成根路径
  expect(normalizeBaseUrl('https://portal.example.com/token-report/')).toBe('https://portal.example.com/token-report')
  expect(endpointOf('https://portal.example.com/token-report')).toBe('https://portal.example.com/token-report/api/v1/token-usage')
  expect(baseUrlOf(endpoint)).toBe(baseUrl)
  for (const bad of ['http://user:pass@host', 'http://host/?a=1', 'ftp://host', 'http://host/#x'])
    expect(() => normalizeBaseUrl(bad)).toThrow()
})