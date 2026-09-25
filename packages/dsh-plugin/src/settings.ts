/**
 * 插件配置页的宿主入口。署名与本地 Web 共用 identity.json；连接设置单独保存。
 * ★ 校验成功才保存，GET 不回传凭证。运行中的上报器保持原配置，重启后统一切换。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readIdentity, resolvePaths, writeIdentity } from '@ai-token-report/core'
import type { EffectiveConfig, RawConfig } from './config.js'

interface SavedConnection { endpoint: string; appKey: string }

function connectionPath(home?: string): string {
  return join(resolvePaths(home).dshHome, 'token-report', 'plugin-connection.json')
}

/** 损坏时沿用部署配置，不让一份配置文件阻止宿主启动。 */
export function readConnection(home?: string): Partial<SavedConnection> {
  try {
    const value = JSON.parse(readFileSync(connectionPath(home), 'utf8'))
    if (typeof value.endpoint === 'string' && typeof value.appKey === 'string') {
      return { endpoint: validEndpoint(value.endpoint), appKey: value.appKey }
    }
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') console.warn('token-report: 本地连接配置损坏，已回退部署配置')
  }
  return {}
}

/** 用户在配置页明确保存的连接优先于部署默认值。固定身份仍由部署配置管理。 */
export function withSavedConnection(raw: RawConfig): RawConfig {
  return { ...raw, ...readConnection(raw.dshHome) }
}

function validEndpoint(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('上报地址必须是不含账号、查询参数或片段的 HTTP(S) 地址')
  }
  if (!url.pathname.endsWith('/api/v1/token-usage')) throw new Error('上报地址需以 /api/v1/token-usage 结尾')
  return url.toString()
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, text, { mode: 0o600 })
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

export function createSettingsHandler(config: EffectiveConfig, options: {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
  locked?: boolean
} = {}): (request: Request) => Promise<Response> {
  const paths = resolvePaths(config.dshHome)
  const fetchImpl = options.fetchImpl ?? fetch
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
  let saving = false
  let restartRequired = false
  return async (request) => {
    if (request.method === 'GET') {
      const identity = config.user ?? readIdentity(paths.identityPath).identity
      const saved = readConnection(config.dshHome)
      return json({ signed: !!identity, name: identity?.name ?? '', dept: identity?.dept ?? '',
        endpoint: saved.endpoint ?? config.endpoint, locked: !!options.locked,
        hasAppKey: !!(saved.appKey ?? config.appKey), restartRequired })
    }
    if (request.method !== 'POST') return json({ ok: false, reason: '不支持的请求方法' }, 405)
    if (options.locked) return json({ ok: false, reason: '配置由部署文件或环境变量管理，请联系管理员修改' })
    if (saving) return json({ ok: false, reason: '正在保存配置，请稍后重试' })
    saving = true
    try {
      const raw = await request.json() as Record<string, unknown>
      const name = typeof raw.name === 'string' ? raw.name.trim() : ''
      const token = typeof raw.token === 'string' ? raw.token.trim() : ''
      const appKey = typeof raw.appKey === 'string' ? raw.appKey.trim() : ''
      if (!name || !token) return json({ ok: false, reason: '请填写姓名与管理员发放的 Key' })
      const endpoint = validEndpoint(typeof raw.endpoint === 'string' ? raw.endpoint.trim() : '')
      const verifyUrl = endpoint.replace(/\/api\/v1\/token-usage$/, '/api/v1/identity/verify')
      let verified: { ok?: boolean; name?: unknown; dept?: unknown; reason?: unknown }
      try {
        const response = await fetchImpl(verifyUrl, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ token }),
        })
        if (!response.ok) return json({ ok: false, reason: `身份校验失败（HTTP ${response.status}）` })
        verified = await response.json() as typeof verified
      } catch {
        return json({ ok: false, reason: '无法连接部门服务端校验 Key，请检查地址与网络后重试' })
      }
      if (!verified || verified.ok !== true || typeof verified.name !== 'string' || !verified.name.trim()) {
        return json({ ok: false, reason: typeof verified?.reason === 'string' ? verified.reason : '服务端未返回有效署名，未保存配置' })
      }
      const path = connectionPath(config.dshHome)
      let previous: string | undefined
      try { previous = readFileSync(path, 'utf8') } catch (err) {
        if ((err as { code?: string }).code !== 'ENOENT') throw err
      }
      atomicWrite(path, JSON.stringify({ endpoint, appKey: appKey || token }))
      const result = writeIdentity(paths.identityPath, {
        name: verified.name.trim(), token,
        ...(typeof verified.dept === 'string' && verified.dept.trim() ? { dept: verified.dept.trim() } : {}),
      })
      if (!result.ok) {
        if (previous !== undefined) atomicWrite(path, previous)
        else rmSync(path, { force: true })
        return json({ ok: false, reason: '署名保存失败，连接设置已回退，请检查目录权限' })
      }
      restartRequired = true
      return json({ ok: true, name: verified.name.trim(), restartRequired: true })
    } catch {
      return json({ ok: false, reason: '配置格式或上报地址无效，或本地文件无法写入；请检查后重试' })
    } finally { saving = false }
  }
}
