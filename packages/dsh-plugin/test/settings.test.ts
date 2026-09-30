/**
 * 配置保存守住四条边界：
 *
 * 1. 服务端身份边界（姓名只信校验响应）
 * 2. 凭证边界（GET 不回显 appKey，错误信息不带它）
 * 3. 失败不覆盖（校验失败 / 锁定 / 非法输入都不得留下半份配置）
 * 4. ★ 保存即生效：四个字段（地址 / appKey / 间隔 / 位置）落盘后
 *    调 `host.apply()`，**不需要重启 DSH**；宿主没提供入口时才回退成重启。
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readIdentity, resolvePaths } from '@ai-token-report/core'
import { resolveConfig, type EffectiveConfig } from '../src/config.js'
import {
  baseUrlOf, createSettingsHandler, endpointOf, normalizeBaseUrl, parseFlushInterval,
  readConnection, withSavedConnection, MAX_FLUSH_INTERVAL_MILLIS, MIN_FLUSH_INTERVAL_MILLIS,
  type SettingsState,
} from '../src/settings.js'

let home: string
/** 用例内额外建的临时目录（DSH Desktop 场景要两个 home）。 */
const extraDirs: string[] = []

/** 建一个本次用例结束就删掉的临时目录。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atr-settings-'))
  extraDirs.push(dir)
  return dir
}

let dataDir: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atr-settings-'))
  // 显式给数据目录：缺省在家目录下（`~/.ai-token-report`），不给就会读写真实身份与连接文件。
  dataDir = join(home, 'token-report')
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const baseUrl = 'http://127.0.0.1:8787'
const endpoint = 'http://127.0.0.1:8787/api/v1/token-usage'

function request(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/tokenReport.settings', { method: 'POST', body: JSON.stringify(body) })
}

/** 当前署名（模拟 broker：直接读身份文件，与宿主 `runtime.identity()` 同源）。 */
function signed(): { name: string; group?: string } | null {
  const identity = readIdentity(resolvePaths({ dshHome: home, dataDir }).identityPath).identity
  if (!identity) return null
  // 与宿主同一口径：新文件 `group`、旧文件 `dept`（兼容规则的真源在 shared）
  const group = identity.group ?? identity.dept
  return { name: identity.name, ...(group ? { group } : {}) }
}

interface HostOptions {
  locked?: boolean
  seen?: string[]
  /** 保存成功后的「就地生效」入口；不给就模拟不支持热生效的旧宿主。 */
  apply?: () => SettingsState['reporting'] | Promise<SettingsState['reporting']>
  /** 覆盖生效配置（测部署侧下发的值）。 */
  config?: Partial<EffectiveConfig>
}

function handler(result: unknown, options: HostOptions = {}) {
  const config: EffectiveConfig = { ...resolveConfig({ dshHome: home, dataDir }), ...options.config }
  return createSettingsHandler(
    {
      state: (): SettingsState => ({
        config,
        identity: signed(),
        saved: readConnection({ dshHome: home, dataDir }),
        reporting: { enabled: false, endpoint: config.endpoint, reason: '未启用' },
        locked: options.locked ?? false,
      }),
      ...(options.apply
        ? { apply: async () => options.apply!() }
        : {}),
    },
    {
      fetchImpl: async (url) => { options.seen?.push(String(url)); return Response.json(result) },
    },
  )
}

/** 把「保存后生效」的入口记下来，模拟运行时刷新。 */
function handlerWithApply(result: unknown): { run: (request: Request) => Promise<Response>; calls: () => number } {
  let calls = 0
  const run = handler(result, {
    apply: () => {
      calls += 1
      const saved = readConnection({ dshHome: home, dataDir })
      return { enabled: true, endpoint: endpointOf(saved.baseUrl ?? baseUrl) }
    },
  })
  return { run, calls: () => calls }
}

test('保存 appKey 与地址，GET 不回传任何 Key，重启后连接可恢复', async () => {
  const seen: string[] = []
  const run = handler({ ok: true, name: '服务端姓名', group: '研发' }, { seen })
  const response = await run(request({ baseUrl, appKey: 'report-secret' }))
  expect(await response.json()).toMatchObject({ ok: true, name: '服务端姓名', restartRequired: true })
  // ★ 校验地址由 baseUrl 推导，用户不需要自己拼 /api/v1/identity/verify
  expect(seen).toEqual(['http://127.0.0.1:8787/api/v1/identity/verify'])
  // ★ token 就是 appKey：本地页与 CLI 读同一份身份文件
  expect(readIdentity(resolvePaths({ dshHome: home, dataDir }).identityPath).identity).toMatchObject({ name: '服务端姓名', token: 'report-secret', group: '研发' })
  const text = await (await run(new Request('http://localhost/api/tokenReport.settings'))).text()
  expect(text).not.toContain('report-secret')
  const get = JSON.parse(text) as Record<string, unknown>
  expect(get).toMatchObject({ signed: true, name: '服务端姓名', baseUrl })
  // ★「保存后要不要重启」由宿主能力决定：没给 apply 就说实话要重启
  expect(get['restartRequired']).toBe(true)
  expect(withSavedConnection({ dshHome: home, dataDir })).toMatchObject({ endpoint, appKey: 'report-secret' })
  expect(withSavedConnection({ dshHome: home, dataDir, appKey: 'deployment-key' }).appKey).toBe('report-secret')
})

test('★ 保存成功即生效：四个字段落盘后调 host.apply()，不再要求重启', async () => {
  const { run, calls } = handlerWithApply({ ok: true, name: '张三', group: '研发' })
  const body = await (await run(request({
    baseUrl, appKey: 'report-secret', flushIntervalMillis: 30_000, position: 'both',
  }))).json() as Record<string, unknown>

  expect(body).toMatchObject({
    ok: true, name: '张三', applied: true, restartRequired: false,
    flushIntervalMillis: 30_000, position: 'both',
  })
  expect(calls()).toBe(1)
  // 生效结果如实回给页面（面板上要显示「上报中 / 已停止及原因」）
  expect(body['reporting']).toMatchObject({ enabled: true })
  // ★ 落盘的是用户选的偏好，不只是连接
  expect(readConnection({ dshHome: home, dataDir })).toEqual({
    baseUrl, appKey: 'report-secret', flushIntervalMillis: 30_000, position: 'both',
  })
  // 同一个 handler 的 GET 必须立刻反映新值（页面保存后不再显示旧间隔）
  const get = await (await run(new Request('http://localhost/api/tokenReport.settings'))).json() as Record<string, unknown>
  expect(get).toMatchObject({ flushIntervalMillis: 30_000, position: 'both' })
})

test('★ 偏好落进生效配置：间隔与位置可以就地生效而不必改部署文件', () => {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'plugin-connection.json'), JSON.stringify(
    { baseUrl, appKey: 'k', flushIntervalMillis: 5_000, position: 'header' },
  ))
  const merged = withSavedConnection({ dshHome: home, dataDir, batch: { flushIntervalMillis: 10_000 }, ui: { position: 'dock' } })
  expect(merged.batch?.flushIntervalMillis).toBe(5_000)
  expect(merged.ui?.position).toBe('header')
  expect(resolveConfig(merged).batch.flushIntervalMillis).toBe(5_000)
  expect(resolveConfig(merged).ui.position).toBe('header')
  // 没保存过偏好的部署，仍按部署配置走
  const fresh = mkdtempSync(join(tmpdir(), 'atr-settings-nopref-'))
  try {
    expect(withSavedConnection({ dshHome: fresh, batch: { flushIntervalMillis: 7_000 } }).batch?.flushIntervalMillis).toBe(7_000)
  } finally { rmSync(fresh, { recursive: true, force: true }) }
})

test('★ 非法间隔与位置在本地就拦下（不许静默当成没给）', async () => {
  const seen: string[] = []
  const run = handler({ ok: true, name: '不该被用到' }, { seen })
  for (const bad of [0, -1, 999, 1_000.5, MAX_FLUSH_INTERVAL_MILLIS + 1, '10000', null]) {
    const response = await run(request({ baseUrl, appKey: 'k', flushIntervalMillis: bad }))
    expect(await response.json()).toMatchObject({ ok: false })
  }
  for (const bad of ['nowhere', 'DOCK', 3, true]) {
    const response = await run(request({ baseUrl, appKey: 'k', position: bad }))
    expect(await response.json()).toMatchObject({ ok: false })
  }
  // 一个字节的校验请求都不该发出去
  expect(seen).toEqual([])
  expect(readConnection({ dshHome: home, dataDir })).toEqual({})
})

test('间隔取值边界：闭区间内合法，且只认整毫秒数', () => {
  expect(parseFlushInterval(MIN_FLUSH_INTERVAL_MILLIS)).toBe(1_000)
  expect(parseFlushInterval(MAX_FLUSH_INTERVAL_MILLIS)).toBe(MAX_FLUSH_INTERVAL_MILLIS)
  expect(parseFlushInterval(10_000)).toBe(10_000)
  expect(parseFlushInterval(10_000.5)).toBeUndefined()
  expect(parseFlushInterval(Number.NaN)).toBeUndefined()
  expect(parseFlushInterval(Number.POSITIVE_INFINITY)).toBeUndefined()
  expect(parseFlushInterval(999)).toBeUndefined()
  expect(parseFlushInterval('10000')).toBeUndefined()
  expect(parseFlushInterval(undefined)).toBeUndefined()
})

test('不传偏好时不覆盖已保存的偏好（部分客户端不会把设置清空）', async () => {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'plugin-connection.json'), JSON.stringify(
    { baseUrl, appKey: 'old', flushIntervalMillis: 60_000, position: 'both' },
  ))
  await handler({ ok: true, name: '张三' })(request({ baseUrl, appKey: 'new' }))
  expect(readConnection({ dshHome: home, dataDir })).toEqual({
    baseUrl, appKey: 'new', flushIntervalMillis: 60_000, position: 'both',
  })
})

test('★ 已配好凭证时留空 appKey：只更新本机偏好，不重校验也不重写身份', async () => {
  await handler({ ok: true, name: '张三', group: '研发' })(request({ baseUrl, appKey: 'secret' }))
  const identityBefore = readIdentity(resolvePaths({ dshHome: home, dataDir }).identityPath).identity
  const seen: string[] = []
  let applied = 0
  const run = handler({ ok: true, name: '不该被用到' }, {
    seen,
    apply: () => { applied += 1; return { enabled: true, endpoint } },
  })

  const body = await (await run(request({ appKey: '', flushIntervalMillis: 5_000, position: 'both' }))).json()
  expect(body).toMatchObject({
    ok: true, name: '张三', flushIntervalMillis: 5_000, position: 'both',
    applied: true, restartRequired: false,
  })
  // ★ 一个校验请求都不发：那串密钥往往已经不在用户手边
  expect(seen).toEqual([])
  // ★ 但「就地生效」照做 —— 改完间隔立刻按新间隔上报
  expect(applied).toBe(1)
  expect(readConnection({ dshHome: home, dataDir })).toEqual({
    baseUrl, appKey: 'secret', flushIntervalMillis: 5_000, position: 'both',
  })
  // 身份文件一个字节都没动（没重新校验就不该重写署名）
  expect(readIdentity(resolvePaths({ dshHome: home, dataDir }).identityPath).identity).toEqual(identityBefore)
})

test('★ 留空 appKey 却改了地址 → 拒绝，且旧连接原样保留', async () => {
  await handler({ ok: true, name: '张三' })(request({ baseUrl, appKey: 'secret' }))
  const seen: string[] = []
  const body = await handler({ ok: true, name: '不该被用到' }, { seen })(
    request({ baseUrl: 'http://127.0.0.1:9999', appKey: '' }),
  ).then((r) => r.json() as Promise<Record<string, unknown>>)

  expect(body['ok']).toBe(false)
  expect(String(body['reason'])).toContain('appKey')
  expect(seen).toEqual([])
  expect(readConnection({ dshHome: home, dataDir }).baseUrl).toBe(baseUrl)
})

test('★ 从没配过凭证时留空 appKey：拦在本地，也不留下半份偏好', async () => {
  const seen: string[] = []
  const body = await handler({ ok: true, name: '不该被用到' }, { seen })(
    request({ appKey: '', flushIntervalMillis: 5_000, position: 'both' }),
  ).then((r) => r.json() as Promise<Record<string, unknown>>)
  expect(body['ok']).toBe(false)
  expect(seen).toEqual([])
  expect(readConnection({ dshHome: home, dataDir })).toEqual({})
})

test('缺服务端姓名的成功响应不能退回客户端提交内容', async () => {
  const response = await handler({ ok: true })(request({ baseUrl, appKey: 'secret' }))
  expect(await response.json()).toMatchObject({ ok: false })
  expect(readIdentity(resolvePaths({ dshHome: home, dataDir }).identityPath).identity).toBeNull()
  expect(readConnection({ dshHome: home, dataDir })).toEqual({})
})

test('验证失败保留原配置，部署锁定时不保存', async () => {
  await handler({ ok: true, name: '原署名' })(request({ baseUrl, appKey: 'old' }))
  const response = await handler({ ok: false, reason: 'Key 无效' })(request({ baseUrl, appKey: 'new' }))
  expect(await response.json()).toMatchObject({ reason: 'Key 无效' })
  expect(readConnection({ dshHome: home, dataDir }).appKey).toBe('old')
  expect(readIdentity(resolvePaths({ dshHome: home, dataDir }).identityPath).identity?.name).toBe('原署名')
  const locked = await handler({ ok: true, name: '新姓名' }, { locked: true })(request({ baseUrl, appKey: 'new' }))
  expect(await locked.json()).toMatchObject({ ok: false })
})

test('★ 校验响应兼容旧服务端：只回 `dept` 时分组也必须落盘', async () => {
  // 迁移期尚未升级的服务端只返回 `dept`（与 `group` 同值）。
  // 只读 `group` 会让分组被静默丢掉 —— 不报错，只是那个字段空了。
  await handler({ ok: true, name: '张三', dept: '研发' })(request({ baseUrl, appKey: 'secret' }))
  expect(readIdentity(resolvePaths({ dshHome: home, dataDir }).identityPath).identity)
    .toMatchObject({ name: '张三', group: '研发' })
})

test('地址与凭证缺失都在本地就拦下，不发任何校验请求', async () => {
  const seen: string[] = []
  const run = handler({ ok: true, name: '不该被用到' }, { seen })
  expect(await (await run(request({ baseUrl, appKey: '   ' }))).json()).toMatchObject({ ok: false })
  expect(await (await run(request({ baseUrl: 'ftp://nope', appKey: 'k' }))).json()).toMatchObject({ ok: false })
  expect(seen).toEqual([])
})

test('不把校验请求重定向到其它地址，网络错误不回显凭证', async () => {
  const run = createSettingsHandler(
    {
      state: (): SettingsState => ({
        config: resolveConfig({ dshHome: home, dataDir }),
        identity: signed(),
        saved: readConnection({ dshHome: home, dataDir }),
        reporting: { enabled: false, endpoint, reason: '未启用' },
        locked: false,
      }),
    },
    {
      fetchImpl: async (_url, init) => {
        expect(init?.redirect).toBe('error')
        throw new Error('secret-key')
      },
    },
  )
  const result = await run(request({ baseUrl, appKey: 'secret-key' }))
  expect(await result.text()).not.toContain('secret-key')
  expect(readConnection({ dshHome: home, dataDir })).toEqual({})
})

test('旧版只存 endpoint 的配置仍可读，升级后不必重填', async () => {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'plugin-connection.json'), JSON.stringify({ endpoint, appKey: 'legacy' }))
  expect(readConnection({ dshHome: home, dataDir })).toEqual({ baseUrl, appKey: 'legacy' })
  // 旧文件只有连接、没有身份：面板应回填地址并如实说「未署名」，而不是地址空着要人重填
  expect(await (await handler({ ok: true, name: '旧配置' })(new Request('http://localhost/api/tokenReport.settings'))).json())
    .toMatchObject({ baseUrl, signed: false, hasAppKey: true })
})

test('★ 没有 appKey 时偏好也照读：位置与间隔不该被凭证绑住', () => {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'plugin-connection.json'), JSON.stringify(
    { flushIntervalMillis: 5_000, position: 'header' },
  ))
  // 凭证不成对 → 不认连接；但偏好是纯本机选择，必须留下
  expect(readConnection({ dshHome: home, dataDir })).toEqual({ flushIntervalMillis: 5_000, position: 'header' })
})

test('损坏的连接文件回退到部署配置，且不抛错', () => {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'plugin-connection.json'), '{ 坏 JSON')
  expect(readConnection({ dshHome: home, dataDir })).toEqual({})
  expect(withSavedConnection({ dshHome: home, dataDir, appKey: 'deployment' }).appKey).toBe('deployment')
})

/**
 * ★ DSH Desktop 场景：会话日志读本机 home，身份与连接放在共享数据目录。
 *
 * 这是本次两个目录分开的**唯一目的** —— Desktop 的 `DSH_HOME` 与命令行版不同，
 * 只想共用一份凭证时不能去动 `dshHome`（那会连日志来源一起换掉）。
 */
test('★ dataDir 指向共享目录：保存把身份与连接写在那里，本机 home 一个字节都不写', async () => {
  const desktopHome = tempDir()
  const sharedData = tempDir()
  const config = resolveConfig({ dshHome: desktopHome, dataDir: sharedData })
  let signed: { name: string; group?: string } | null = null

  const run = createSettingsHandler({
    state: (): SettingsState => ({
      config,
      identity: signed,
      saved: readConnection(config),
      reporting: { enabled: false, endpoint: config.endpoint, reason: '未启用' },
      locked: false,
    }),
  }, { fetchImpl: async () => Response.json({ ok: true, name: '共享姓名', group: '研发' }) })

  const body = await (await run(request({ baseUrl, appKey: 'shared-secret' }))).json() as Record<string, unknown>
  expect(body).toMatchObject({ ok: true, name: '共享姓名' })
  signed = { name: '共享姓名', group: '研发' }

  // 身份与连接都落在**共享数据目录**
  expect(readIdentity(join(sharedData, 'identity.json')).identity)
    .toMatchObject({ name: '共享姓名', token: 'shared-secret', group: '研发' })
  expect(readConnection(config)).toMatchObject({ baseUrl, appKey: 'shared-secret' })
  // 本机 DSH home 下连 token-report 目录都不该出现（没有那份身份，也不该有孤儿文件）
  expect(existsSync(join(desktopHome, 'token-report'))).toBe(false)
  // GET 也按同一份数据回答
  expect(await (await run(new Request('http://localhost/api/tokenReport.settings'))).json())
    .toMatchObject({ signed: true, name: '共享姓名', baseUrl })
})

test('★ 共用凭证：只给 dataDir 的配置能读到，没给 dataDir 的读不到', () => {
  const desktopHome = tempDir()
  const sharedData = tempDir()
  writeFileSync(join(sharedData, 'plugin-connection.json'), JSON.stringify({ baseUrl, appKey: 'shared' }))

  expect(withSavedConnection({ dshHome: desktopHome, dataDir: sharedData }))
    .toMatchObject({ appKey: 'shared', endpoint })
  // 没指共享目录时按本机默认位置读 —— 读不到就老实回退部署配置，不许串台
  expect(withSavedConnection({ dshHome: desktopHome, appKey: 'deployment' }).appKey).toBe('deployment')
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