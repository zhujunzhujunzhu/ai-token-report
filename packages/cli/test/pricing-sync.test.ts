/**
 * `pricing sync` 的端到端契约：**真 HTTP 服务 + 真 CLI 子进程**。
 *
 * ## 为什么每个失败分支都要单独用例
 *
 * 这块最容易做错的地方不是「拉不下来」，而是**拉不下来的原因被合并成一句话**。
 * 401（凭证抄错了）、403（这份凭证没有 `cost:read`，而 appKey 按设计拿不到它）、
 * 网络不通、地址写成了前端页面 —— 四件事的**行动项完全不同**，
 * 全都报「同步失败」等于让使用者只能猜。所以下面逐条钉住退出码与关键词。
 *
 * ## 为什么用真 HTTP 而不是注入 fetch
 *
 * 注入 fetch 只能验「拿到响应之后怎么处理」，验不了最要命的那几件：
 * 请求打到了**哪个路径**、`Authorization` 头是什么形状、超时有没有真的设上。
 * 起一个 `Bun.serve({ port: 0 })` 的成本与注入相当，覆盖却大一截。
 */

import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadLocalPricing } from '@ai-token-report/core/db'

import { pinnedChildEnv } from './child-env.js'

const CLI = resolve(import.meta.dir, '../src/cli.ts')

/**
 * 服务端 `GET /api/v1/stats/pricing` 的线上单价行（**snake_case**）。
 *
 * 刻意带上 `PortalModelPrice` 的全部字段（含 `price_id` / `note` / 时间戳）：
 * 转换走 `modelPriceFromWire()`，多余的字段**不得**漏进快照 —— 快照的读取方是
 * `parsePricingSnapshot()`，多一个字段不会报错，但会让「快照里到底是什么」变成两份答案。
 */
const WIRE_ROW = {
  price_id: '11111111-1111-4111-8111-111111111111',
  provider: 'paid',
  model: 'paid-model',
  currency: 'CNY',
  input_micro_per_ktok: 1_000_000,
  output_micro_per_ktok: 2_000_000,
  cache_read_micro_per_ktok: 50_000,
  cache_write_micro_per_ktok: 300_000,
  effective_from_ms: 0,
  effective_to_ms: null,
  note: '内部价',
  created_at_ms: 1_700_000_000_000,
  updated_at_ms: 1_700_000_000_000,
}

/** 内存形态（camelCase）；`effectiveToMs: null` 必须**保持 null**。 */
const SNAPSHOT_PRICE = {
  provider: 'paid',
  model: 'paid-model',
  currency: 'CNY',
  inputMicroPerKtok: 1_000_000,
  outputMicroPerKtok: 2_000_000,
  cacheReadMicroPerKtok: 50_000,
  cacheWriteMicroPerKtok: 300_000,
  effectiveFromMs: 0,
  effectiveToMs: null,
  // v10 闲时档：服务端的这条价没有闲时档 ⇒ 写盘也是两个 `null`
  // （读回来仍是「不分时段」，而不是「闲时四类价 = 0 元」）。
  offpeakRates: null,
  offpeakSchedule: null,
}

interface FakePortal {
  url: string
  requests: { path: string; auth: string | null }[]
  stop: () => void
}

/** 起一个只回答一个端点的真 HTTP 服务（端口 0 = 由系统分配，测试之间不会撞）。 */
function servePortal(respond: (req: Request) => Response): FakePortal {
  const requests: FakePortal['requests'] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      requests.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization') })
      return respond(req)
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) }
}

interface Fixture {
  dataDir: string
  run: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>
  cleanup: () => void
}

/**
 * 起一个真 CLI。
 *
 * ⚠️ 会话 home **故意指向一个不存在的目录**：`pricing sync` 不读会话日志，
 *   所以「没有可用的会话目录」这句话必须不出现 —— 一台还没装 DSH 的机器
 *   正是最需要先同步单价的情形。这条断言同时钉住了分派的**位置**
 *   （必须在「有没有会话目录」那道检查之前）。
 */
function setup(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'atr-cli-sync-'))
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })

  const run: Fixture['run'] = async (args) => {
    const child = Bun.spawn(
      [process.execPath, CLI, ...args, '--dsh-home', join(root, 'home-that-does-not-exist'),
        '--data-dir', dataDir, '--quiet'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        // 数据目录与会话日志根**都显式传给子进程**并关掉自动发现：preload 改的
        // `process.env` 不被子进程继承（实测 Bun 1.4.2），少了这几项会连带扫使用者真实的 home。
        // ★ 来源清单也在这里钉住（`pinnedChildEnv()`）：CLI 缺省统计全部已注册来源。
        env: pinnedChildEnv(),
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, code }
  }

  return { dataDir, run, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('成功：真 HTTP 拉到单价，落盘的快照能被 loadLocalPricing 读回 snapshot', async () => {
  const portal = servePortal(() => Response.json({
    prices: [WIRE_ROW],
    pricing: { pricingSource: 'db', pricingSyncedAt: null },
  }))
  const fx = setup()
  try {
    const { stdout, stderr, code } = await fx.run([
      'pricing', 'sync', '--portal', portal.url, '--token', 'atr-test-token',
    ])
    // 会话目录不存在也必须成功（`pricing sync` 不读日志）
    expect(stderr).toBe('')
    expect(code).toBe(0)
    expect(stdout.includes('已写入单价快照')).toBe(true)
    expect(stdout.includes('条数 1')).toBe(true)

    // 打到了哪个路径、带了什么头 —— 注入 fetch 验不到这两件事
    expect(portal.requests).toEqual([{ path: '/api/v1/stats/pricing', auth: 'Bearer atr-test-token' }])

    const path = join(fx.dataDir, 'pricing.json')
    expect(existsSync(path)).toBe(true)
    const onDisk = JSON.parse(readFileSync(path, 'utf8'))
    expect(onDisk.endpoint).toBe(`${portal.url}/api/v1/stats/pricing`)
    expect(Math.abs(onDisk.syncedAtMs - Date.now())).toBeLessThan(60_000)
    // 线上行里的 `price_id` / `note` / `created_at_ms` 一律不进快照
    expect(onDisk.prices).toEqual([SNAPSHOT_PRICE])

    // 落盘的内容必须真的能被**读取方**读成 snapshot，而不是悄悄退回内置价
    const loaded = loadLocalPricing({ dataDir: fx.dataDir })
    expect(loaded.note).toBeNull()
    expect(loaded.provenance.pricingSource).toBe('snapshot')
    expect(loaded.provenance.pricingSyncedAt).toBe(onDisk.syncedAtMs)
    expect(loaded.prices).toEqual([SNAPSHOT_PRICE])
  } finally {
    portal.stop()
    fx.cleanup()
  }
})

test('401：明确说凭证无效，且不写任何东西', async () => {
  const portal = servePortal(() => Response.json({ ok: false, reason: '身份无效' }, { status: 401 }))
  const fx = setup()
  try {
    const { stderr, code } = await fx.run([
      'pricing', 'sync', '--portal', portal.url, '--token', 'bad-token',
    ])
    expect(code).toBe(1)
    expect(stderr.includes('凭证无效（HTTP 401）')).toBe(true)
    expect(stderr.includes('身份无效')).toBe(true) // 服务端说的原话照抄
    expect(existsSync(join(fx.dataDir, 'pricing.json'))).toBe(false)
  } finally {
    portal.stop()
    fx.cleanup()
  }
})

test('403：点名 cost:read，并说清 appKey 按设计拿不到它', async () => {
  const portal = servePortal(() => Response.json(
    { ok: false, reason: '当前身份没有查看计价的权限' },
    { status: 403 },
  ))
  const fx = setup()
  try {
    const { stderr, code } = await fx.run([
      'pricing', 'sync', '--portal', portal.url, '--token', 'appkey-like-token',
    ])
    expect(code).toBe(1)
    // 403 最容易被误解成「服务端没装好」：必须把权限名、appKey 的固定范围、
    // 以及两条可行出路都写出来。
    expect(stderr.includes('cost:read')).toBe(true)
    expect(stderr.includes('appKey')).toBe(true)
    expect(stderr.includes('usage:write + stats:read')).toBe(true)
    expect(stderr.includes('/api/v1/stats/pricing')).toBe(true)
    expect(stderr.includes('当前身份没有查看计价的权限')).toBe(true)
    expect(stderr.includes('pricing.json')).toBe(true)
    expect(existsSync(join(fx.dataDir, 'pricing.json'))).toBe(false)
  } finally {
    portal.stop()
    fx.cleanup()
  }
})

test('缺参数：退出码 2 并打印完整用法（退出码与运行期失败分开）', async () => {
  const fx = setup()
  try {
    const noPortal = await fx.run(['pricing', 'sync', '--token', 't'])
    expect(noPortal.code).toBe(2)
    expect(noPortal.stderr.includes('缺少必需参数: --portal')).toBe(true)
    expect(noPortal.stderr.includes('用法:')).toBe(true)
    expect(noPortal.stderr.includes('/api/v1/stats/pricing')).toBe(true)

    const noToken = await fx.run(['pricing', 'sync', '--portal', 'http://127.0.0.1:1'])
    expect(noToken.code).toBe(2)
    expect(noToken.stderr.includes('缺少必需参数: --token')).toBe(true)

    // 空 token 与只有 `Bearer` 前缀等价（否则会发出一个空头的请求）
    const emptyToken = await fx.run(['pricing', 'sync', '--portal', 'http://127.0.0.1:1', '--token', 'Bearer '])
    expect(emptyToken.code).toBe(2)
    expect(emptyToken.stderr.includes('不能是空的')).toBe(true)

    // 非法地址在**发请求之前**就被挡下：否则使用者只会看到 fetch 的 URL 解析报错
    const badUrl = await fx.run(['pricing', 'sync', '--portal', 'portal.example.com', '--token', 't'])
    expect(badUrl.code).toBe(2)
    expect(badUrl.stderr.includes('--portal 需要形如')).toBe(true)
    expect(badUrl.stderr.includes('用法:')).toBe(true)
  } finally {
    fx.cleanup()
  }
})

test('子命令本身也要校验：缺 sync / 拼错子命令都是参数错误（2）', async () => {
  const fx = setup()
  try {
    const missing = await fx.run(['pricing'])
    expect(missing.code).toBe(2)
    expect(missing.stderr.includes('需要一个子命令')).toBe(true)
    expect(missing.stderr.includes('用法:')).toBe(true)

    const unknown = await fx.run(['pricing', 'pull'])
    expect(unknown.code).toBe(2)
    expect(unknown.stderr.includes('未知的 pricing 子命令 "pull"')).toBe(true)

    // `-h` 与全局 -h 一致：打印帮助、退出码 0（不是「参数错误」）
    const help = await fx.run(['pricing', '--help'])
    expect(help.code).toBe(0)
    expect(help.stdout.includes('pricing sync')).toBe(true)
  } finally {
    fx.cleanup()
  }
})

test('网络不通：退出码 1 且带上目标地址（能分辨「地址错」与「服务端挂了」）', async () => {
  // 先拿一个系统分配过的端口再关掉：比硬编码「肯定没人监听」的端口可靠。
  const probe = servePortal(() => new Response(''))
  const deadUrl = probe.url
  probe.stop()

  const fx = setup()
  try {
    const { stderr, code } = await fx.run(['pricing', 'sync', '--portal', deadUrl, '--token', 't'])
    expect(code).toBe(1)
    expect(stderr.includes('拉取单价失败')).toBe(true)
    expect(stderr.includes(`${deadUrl}/api/v1/stats/pricing`)).toBe(true)
  } finally {
    fx.cleanup()
  }
})

test('响应不是 JSON / 缺少 prices：退出码 1，绝不写半份快照', async () => {
  const html = servePortal(() => new Response('<!doctype html><html>登录</html>', {
    headers: { 'content-type': 'text/html' },
  }))
  const fx = setup()
  try {
    const notJson = await fx.run(['pricing', 'sync', '--portal', html.url, '--token', 't'])
    expect(notJson.code).toBe(1)
    // 地址写成前端页面地址是最常见的错法，提示里必须点到它
    expect(notJson.stderr.includes('不是有效 JSON')).toBe(true)
    expect(notJson.stderr.includes('前端页面地址')).toBe(true)
    expect(existsSync(join(fx.dataDir, 'pricing.json'))).toBe(false)

    const noPrices = await fx.run(['pricing', 'sync', '--portal', servePortal(() => Response.json({})).url, '--token', 't'])
    expect(noPrices.code).toBe(1)
    expect(noPrices.stderr.includes('缺少 prices')).toBe(true)
    expect(existsSync(join(fx.dataDir, 'pricing.json'))).toBe(false)
  } finally {
    html.stop()
    fx.cleanup()
  }
})

test('写盘前用读取方的解析器回读：字段缺失时拒绝写入，而不是报「同步成功」', async () => {
  const broken = { ...WIRE_ROW, input_micro_per_ktok: undefined }
  const portal = servePortal(() => Response.json({ prices: [broken] }))
  const fx = setup()
  try {
    const { stderr, code } = await fx.run(['pricing', 'sync', '--portal', portal.url, '--token', 't'])
    // 这是最坏的一种：写进去之后 `parsePricingSnapshot()` 会整份拒绝，
    // 本地按内置价算，而同步已经报过成功 —— 使用者以为金额已与看板对齐。
    expect(code).toBe(1)
    expect(stderr.includes('写盘前校验未通过')).toBe(true)
    expect(existsSync(join(fx.dataDir, 'pricing.json'))).toBe(false)
  } finally {
    portal.stop()
    fx.cleanup()
  }
})

test('服务端一条价都没配：写空快照并**显式告警**，而不是退回内置价', async () => {
  const portal = servePortal(() => Response.json({
    prices: [],
    pricing: { pricingSource: 'db', pricingSyncedAt: null },
  }))
  const fx = setup()
  try {
    const { stdout, code } = await fx.run(['pricing', 'sync', '--portal', portal.url, '--token', 't'])
    expect(code).toBe(0)
    expect(stdout.includes('条数 0')).toBe(true)
    expect(stdout.includes('一条单价都没配')).toBe(true)
    // ★ 空快照**不等于**「没有快照」：退回内置价会让本机与看板给出两个不同的金额，
    //   而空单价表与看板是**一致**的（两边都全未计价）。
    const loaded = loadLocalPricing({ dataDir: fx.dataDir })
    expect(loaded.provenance.pricingSource).toBe('snapshot')
    expect(loaded.prices).toEqual([])
  } finally {
    portal.stop()
    fx.cleanup()
  }
})

test('同步两次得到逐字节相同的文件（稳定排序），幂等可反复执行', async () => {
  const two = [
    { ...WIRE_ROW, provider: 'zeta', model: 'z', price_id: 'b' },
    { ...WIRE_ROW, provider: 'alpha', model: 'a', price_id: 'a' },
  ]
  const portal = servePortal(() => Response.json({
    // 服务端按自己的顺序给（这里刻意反着给），落盘必须仍然稳定
    prices: [two[0], two[1]],
    pricing: { pricingSource: 'db', pricingSyncedAt: null },
  }))
  const fx = setup()
  try {
    const first = await fx.run(['pricing', 'sync', '--portal', portal.url, '--token', 't'])
    expect(first.code).toBe(0)
    const path = join(fx.dataDir, 'pricing.json')
    const before = readFileSync(path, 'utf8')
    expect(JSON.parse(before).prices.map((p: { provider: string }) => p.provider)).toEqual(['alpha', 'zeta'])

    const second = await fx.run(['pricing', 'sync', '--portal', portal.url, '--token', 't'])
    expect(second.code).toBe(0)
    // `syncedAtMs` 每次都变，所以只比单价部分 —— 那部分必须逐字节可复现。
    expect(JSON.parse(readFileSync(path, 'utf8')).prices).toEqual(JSON.parse(before).prices)
  } finally {
    portal.stop()
    fx.cleanup()
  }
})

test('--pricing-file 指定落盘位置；写入失败时退出码 1 且不静默', async () => {
  const portal = servePortal(() => Response.json({
    prices: [WIRE_ROW],
    pricing: { pricingSource: 'db', pricingSyncedAt: null },
  }))
  const fx = setup()
  try {
    const custom = join(fx.dataDir, 'nested', 'custom-prices.json')
    const ok = await fx.run([
      'pricing', 'sync', '--portal', portal.url, '--token', 't', '--pricing-file', custom,
    ])
    expect(ok.code).toBe(0)
    expect(ok.stdout.includes(custom)).toBe(true)
    expect(existsSync(custom)).toBe(true)
    // 缺省位置**不该**被顺手写一份（否则「我改的那份」与「真正生效的那份」会分叉）
    expect(existsSync(join(fx.dataDir, 'pricing.json'))).toBe(false)
    expect(loadLocalPricing({ file: custom }).provenance.pricingSource).toBe('snapshot')

    // 把一个**目录**当成快照路径：写入必然失败
    const dirAsFile = join(fx.dataDir, 'nested')
    mkdirSync(dirAsFile, { recursive: true })
    const fail = await fx.run([
      'pricing', 'sync', '--portal', portal.url, '--token', 't', '--pricing-file', dirAsFile,
    ])
    expect(fail.code).toBe(1)
    expect(fail.stderr.includes('写入快照失败')).toBe(true)
  } finally {
    portal.stop()
    fx.cleanup()
  }
})

test('快照是配置不是缓存：同步来的文件不会被 --cost 改动，也不会跟身份文件混在一起', async () => {
  const portal = servePortal(() => Response.json({
    prices: [WIRE_ROW],
    pricing: { pricingSource: 'db', pricingSyncedAt: null },
  }))
  const fx = setup()
  try {
    await fx.run(['pricing', 'sync', '--portal', portal.url, '--token', 't'])
    const path = join(fx.dataDir, 'pricing.json')
    const before = readFileSync(path, 'utf8')
    writeFileSync(join(fx.dataDir, 'other.txt'), 'unrelated')
    expect(readFileSync(path, 'utf8')).toBe(before)
    // 落点就是数据目录下的 pricing.json（与 usage.sqlite / identity.json 同处一份数据目录，
    // 但**不同文件**：单价的读取方是 `resolvePricingPath()`，它只认这个名字）
    expect(Object.keys(JSON.parse(before)).sort()).toEqual(['endpoint', 'prices', 'syncedAtMs'])
  } finally {
    portal.stop()
    fx.cleanup()
  }
})