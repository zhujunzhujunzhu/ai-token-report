/** 配置保存守住服务端身份边界、凭证不回显与失败不覆盖。 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readIdentity, resolvePaths } from '@ai-token-report/core'
import { resolveConfig } from '../src/config.js'
import { createSettingsHandler, readConnection, withSavedConnection } from '../src/settings.js'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'atr-settings-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })
const endpoint = 'http://127.0.0.1:8787/api/v1/token-usage'
function request(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/tokenReport.settings', { method: 'POST', body: JSON.stringify(body) })
}
function handler(result: unknown, locked = false) {
  return createSettingsHandler(resolveConfig({ dshHome: home }), {
    locked, fetchImpl: (async () => Response.json(result)),
  })
}
test('保存服务端署名，GET 不回传任何 Key，重启后连接可恢复', async () => {
  const run = handler({ ok: true, name: '服务端姓名', dept: '研发' })
  const response = await run(request({ name: '客户端姓名', token: 'identity-secret', appKey: 'report-secret', endpoint }))
  expect(await response.json()).toMatchObject({ ok: true, name: '服务端姓名', restartRequired: true })
  expect(readIdentity(resolvePaths(home).identityPath).identity).toMatchObject({ name: '服务端姓名', token: 'identity-secret', dept: '研发' })
  const text = await (await run(new Request('http://localhost/api/tokenReport.settings'))).text()
  expect(text).not.toContain('identity-secret')
  expect(text).not.toContain('report-secret')
  expect(withSavedConnection({ dshHome: home })).toMatchObject({ endpoint, appKey: 'report-secret' })
  expect(withSavedConnection({ dshHome: home, appKey: 'deployment-key' }).appKey).toBe('report-secret')
})
test('缺服务端姓名的成功响应不能退回客户端姓名', async () => {
  const response = await handler({ ok: true })(request({ name: '伪造姓名', token: 'secret', endpoint }))
  expect(await response.json()).toMatchObject({ ok: false })
  expect(readIdentity(resolvePaths(home).identityPath).identity).toBeNull()
  expect(readConnection(home)).toEqual({})
})
test('验证失败保留原配置，部署锁定时不保存', async () => {
  await handler({ ok: true, name: '原署名' })(request({ name: '原署名', token: 'old', endpoint }))
  const response = await handler({ ok: false, reason: 'Key 无效' })(request({ name: '新姓名', token: 'new', endpoint }))
  expect(await response.json()).toMatchObject({ reason: 'Key 无效' })
  expect(readConnection(home).appKey).toBe('old')
  expect(readIdentity(resolvePaths(home).identityPath).identity?.name).toBe('原署名')
  const locked = await handler({ ok: true, name: '新姓名' }, true)(request({ name: '新姓名', token: 'new', endpoint }))
  expect(await locked.json()).toMatchObject({ ok: false })
})
test('不把校验请求重定向到其它地址，网络错误不回显凭证', async () => {
  const run = createSettingsHandler(resolveConfig({ dshHome: home }), { fetchImpl: (async (_url, init) => {
    expect(init?.redirect).toBe('error')
    throw new Error('secret-key')
  }) })
  const result = await run(request({ name: '姓名', token: 'secret-key', endpoint }))
  expect(await result.text()).not.toContain('secret-key')
  expect(readConnection(home)).toEqual({})
})
