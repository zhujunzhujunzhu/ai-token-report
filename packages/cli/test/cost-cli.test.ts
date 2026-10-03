/**
 * `--cost` 的端到端契约。
 *
 * ## 为什么用真 CLI 子进程
 *
 * `--cost` 的价值全在「命令行 → 取价 → 分流到三种输出」这条链上。在本进程里直接调
 * `buildCostView()` 就绕过了参数解析与输出分流 —— 而「不开 `--cost` 时输出一个字符
 * 都不变」正是只能靠真实 stdout 断言的那一条。
 *
 * ## 为什么金额是手算出来的
 *
 * 下面每个 token 数都刻意取成整数（1000 / 500 / 2000 / 100），单价也取整，
 * 于是「四类分开乘」的结果是一个能手算验证的整数微元。断言写死这个数字，
 * 是为了让**任何**一次口径漂移（比如把 `cacheRead` 并进 `input`）都变成红色，
 * 而不是一个「看起来还合理」的新数字。
 */

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { pinnedChildEnv } from './child-env.js'

const CLI = resolve(import.meta.dir, '../src/cli.ts')

/** 快照的同步时刻（本地 2026-01-01 09:00）。 */
const SYNCED_MS = new Date(2026, 0, 1, 9, 0).getTime()

/**
 * 已配价的模型：CNY，四类单价都是整数微元 / 千 token。
 *
 * - input 1000 token × 1_000_000 微/千 = 1_000_000（整千，无舍入）
 * - output 500 token × 2_000_000 微/千 = 1_000_000（余数 500/1000 → 恰好一半）
 * - cacheRead 2000 token × 50_000 微/千 = 100_000
 * - cacheWrite 100 token × 300_000 微/千 = 30_000
 *
 * 合计 **2_130_000 微元 = ¥2.13**（`formatCostMicro` 在 |值| ≥ 1 时给 2 位小数）。
 */
const PAID_AMOUNT_MICRO = 2_130_000
/** 已配价那一条的计费 token = 1000 + 500 + 2000 + 100（`reasoning` 不在其中）。 */
const PAID_TOKENS = 3600
/** 未配价那一条：700 + 300。 */
const FREE_TOKENS = 1000

function priceSnapshot(): string {
  return JSON.stringify(
    {
      syncedAtMs: SYNCED_MS,
      endpoint: 'http://portal.test/api/v1/stats/pricing',
      prices: [
        {
          provider: 'paid',
          model: 'paid-model',
          currency: 'CNY',
          inputMicroPerKtok: 1_000_000,
          outputMicroPerKtok: 2_000_000,
          cacheReadMicroPerKtok: 50_000,
          cacheWriteMicroPerKtok: 300_000,
          effectiveFromMs: 0,
          effectiveToMs: null,
        },
      ],
    },
    null,
    2,
  )
}

interface Fixture {
  home: string
  dataDir: string
  cleanup: () => void
  run: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>
}

/**
 * 造一份「一个已配价 + 一个未配价」的最小日志，并起一个真 CLI。
 *
 * ⚠️ 数据目录与会话日志根**都显式传给子进程**，而且关掉自动发现：`bun test` 的 preload
 *   改的 `process.env` 不被子进程继承（实测 Bun 1.4.2），少了这几项这条用例会连带扫
 *   使用者真实的 home 并把本地库写进 `~/.ai-token-report`。
 * ⚠️ **来源清单也必须钉**（`pinnedChildEnv()`）：CLI 缺省统计全部已注册来源，
 *   不钉就会读开发者真实的 Codex / Claude Code / Trae / WorkBuddy 日志。
 */
function setup(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'atr-cli-cost-'))
  const home = join(root, 'home')
  const dataDir = join(root, 'data')
  // 数据目录由测试自己建：CLI 只在需要写东西时才创建它，而 `--cost` 是只读的 ——
  // 「快照放在一个不存在的目录里」会让写快照失败，与用例想验的事无关。
  mkdirSync(dataDir, { recursive: true })

  const write = (sessionId: string, provider: string, model: string, usage: Record<string, number>) => {
    const dir = join(home, 'sessions', 'proj', sessionId)
    mkdirSync(dir, { recursive: true })
    const rows: unknown[] = [
      { type: 'session', cwd: '/work/proj' },
      {
        type: 'assistant/message',
        seq: 1,
        time: new Date(2026, 8, 20, 10, 0).getTime(),
        // ⚠️ `usage` 必须在 `data.usage` 里（`scanner.ts` 读的是 `pick(ev, 'data', 'usage')`）：
        //    放到事件顶层会让「计费事件」为 0，而扫描诊断只会说一句
        //    「assistant/message 无 usage 1」—— 那条用例会**静默地**变成对空数据的断言。
        data: { message: { source: { provider, model } }, usage },
      },
    ]
    writeFileSync(
      join(dir, 'session.v3.jsonl.zstd'),
      zstdCompressSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n')),
    )
  }

  write('session-paid', 'paid', 'paid-model',
    { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100, reasoningTokens: 999 })
  // `reasoningTokens` 刻意给一个很大的值：它**不是**计费总量的一部分（铁律 2），
  // 被算进金额就等于凭空多出一笔钱 —— 而这个错误只体现为「数字略大」。
  write('session-free', 'free', 'free-model',
    { inputTokens: 700, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })

  const run: Fixture['run'] = async (args) => {
    const child = Bun.spawn(
      [process.execPath, CLI, '--dsh-home', home, '--data-dir', dataDir, '--quiet', ...args],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        // ★ 来源也要钉：CLI 缺省是**全部已注册来源**，只关自动发现挡不住
        //   「冷扫开发者真实的 ~/.codex」（本机 1,513 个文件 / 2.8 GB）——
        //   症状是这条用例 5 秒超时，而失败信息与断言毫无关系。见 `child-env.ts`。
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

  return { home, dataDir, cleanup: () => rmSync(root, { recursive: true, force: true }), run }
}

/** 取某一行（表格里按分组键开头的那一行）。 */
function rowOf(text: string, key: string): string {
  const line = text.split('\n').find((l) => l.trim() === key || l.trim().startsWith(key + ' '))
  expect(line, `没有找到分组键为 ${key} 的行:\n${text}`).toBeDefined()
  return line!
}

test('默认关：不带 --cost 时 JSON / CSV / 表格里一位金额都没有', async () => {
  const fx = setup()
  try {
    // 快照放好也没用：不开 --cost 就连价都不读。
    writeFileSync(join(fx.dataDir, 'pricing.json'), priceSnapshot())

    const json = await fx.run(['--format', 'json', '--by', 'provider'])
    expect(json.code).toBe(0)
    const payload = JSON.parse(json.stdout)
    expect('cost' in payload).toBe(false)
    // ★ fixture 自检：不加这一条，整个文件都可能在**空数据**上通过 ——
    //   `usage` 放错层级时扫描诊断只说一句「assistant/message 无 usage」，
    //   「该有的金额」与「一个金额都没有」在断言里就会长得一样。
    expect(payload.totals.calls).toBe(2)
    // `reasoning` 是 output 的子集，**不在**计费恒等式里（铁律 2）：
    // 被算进去就等于凭空多出一笔钱，而这个错误只体现为「数字略大」。
    expect(payload.totals.total).toBe(PAID_TOKENS + FREE_TOKENS)
    expect(payload.totals.reasoning).toBe(999)
    // 不是「cost 为空」而是**整字段缺席**：JSON 消费方靠这个区分「没算」与「算了是 0」。
    expect(json.stdout.includes('amountMicro')).toBe(false)

    const csv = await fx.run(['--format', 'csv', '--by', 'provider'])
    expect(csv.code).toBe(0)
    expect(csv.stdout.includes('# cost')).toBe(false)
    expect(csv.stdout.includes('amountMicro')).toBe(false)

    const table = await fx.run(['--by', 'provider'])
    expect(table.code).toBe(0)
    expect(table.stdout.includes('费用')).toBe(false)
    expect(table.stdout.includes('¥')).toBe(false)
    expect(table.stdout.includes('$')).toBe(false)
  } finally {
    fx.cleanup()
  }
})

test('--cost：JSON 给出金额、未计价 token 与未配价清单，且未计价不进 0', async () => {
  const fx = setup()
  try {
    writeFileSync(join(fx.dataDir, 'pricing.json'), priceSnapshot())
    const { stdout, stderr, code } = await fx.run(['--format', 'json', '--by', 'provider-model', '--cost'])
    expect(stderr).toBe('')
    expect(code).toBe(0)
    const payload = JSON.parse(stdout)
    const cost = payload.cost

    // 价从哪来：同一次查询在「读快照」与「退回内置价」下会给出两个不同的金额，
    // 所以来源必须与金额一起下发。
    expect(cost.pricing).toEqual({ pricingSource: 'snapshot', pricingSyncedAt: SYNCED_MS })

    expect(cost.totals.costs).toEqual([{ currency: 'CNY', amountMicro: PAID_AMOUNT_MICRO, tokens: PAID_TOKENS }])
    expect(cost.totals.pricedTokens).toBe(PAID_TOKENS)
    // ★ 未计价那一条进 unpricedTokens，**绝不**变成一条 amountMicro = 0 的记录。
    expect(cost.totals.unpricedTokens).toBe(FREE_TOKENS)
    expect(cost.totals.totalTokens).toBe(PAID_TOKENS + FREE_TOKENS)
    expect(cost.totals.unpricedRate).toBeCloseTo(FREE_TOKENS / (PAID_TOKENS + FREE_TOKENS), 10)
    expect(cost.totals.pricedRate + cost.totals.unpricedRate).toBeCloseTo(1, 10)
    expect(cost.totals.unpricedTargets).toEqual(['free/free-model'])

    // 分组键与排行表逐字相同（`provider/model` 拼接形式）
    expect(Object.keys(cost.groups['provider-model']).sort()).toEqual(['free/free-model', 'paid/paid-model'])
    expect(cost.groups['provider-model']['paid/paid-model'].costs[0].amountMicro).toBe(PAID_AMOUNT_MICRO)
    // 一条价都没配上的键：`costs` 是**空数组**，不是 `[{amountMicro: 0}]`
    expect(cost.groups['provider-model']['free/free-model'].costs).toEqual([])
    expect(cost.groups['provider-model']['free/free-model'].unpricedTokens).toBe(FREE_TOKENS)
    expect(cost.groups['provider-model']['free/free-model'].pricedTokens).toBe(0)
  } finally {
    fx.cleanup()
  }
})

test('--cost：终端表格给出单价来源、未计价比例、未配价清单，未计价的键显示「未计价」', async () => {
  const fx = setup()
  try {
    writeFileSync(join(fx.dataDir, 'pricing.json'), priceSnapshot())
    const { stdout, stderr, code } = await fx.run(['--by', 'provider', '--cost'])
    expect(stderr).toBe('')
    expect(code).toBe(0)

    expect(stdout.includes('=== 费用（估算） ===')).toBe(true)
    // ⚠️ 这里**不**断言具体时刻：`bun test` 会把父进程的 TZ 强制成 UTC，而子进程
    //    （真 CLI）按操作系统时区解析同一个毫秒值 —— 实测差 8 小时。精确值由上面的
    //    JSON 断言（`pricingSyncedAt === SYNCED_MS`）钉住，这里只钉形状。
    expect(stdout.includes('单价来源: 本地单价快照（同步于 ')).toBe(true)
    expect(/单价来源: 本地单价快照（同步于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}）/.test(stdout)).toBe(true)
    expect(stdout.includes('未计价 21.7%（1,000 Token）')).toBe(true)
    expect(stdout.includes('未配单价: free/free-model')).toBe(true)
    expect(stdout.includes('合计: ¥2.13')).toBe(true)

    // 未配价的键显示「未计价」，**不是** ¥0.00 —— 后者看起来像「这个供应商免费」。
    // ⚠️ 必须在费用节内部找行：排行表里同样有一行 `free …`，
    //    在整份输出上找会命中那一行（它与金额无关）。
    const costSection = stdout.slice(stdout.indexOf('=== 费用（估算） ==='))
    expect(rowOf(costSection, 'free').trimEnd().endsWith('未计价')).toBe(true)
    expect(rowOf(costSection, 'paid').includes('¥2.13')).toBe(true)

    // 费用节紧跟在排行表之后、诊断之前（插错位置会让「金额」与「这是哪一段的合计」断开）
    expect(stdout.indexOf('=== 费用（估算） ===')).toBeGreaterThan(stdout.indexOf('按厂商'))
    expect(stdout.indexOf('=== 费用（估算） ===')).toBeLessThan(stdout.indexOf('=== 总计'))
  } finally {
    fx.cleanup()
  }
})

test('--cost：CSV 用整数微元、未计价单列一节，绝不写成 amountMicro = 0', async () => {
  const fx = setup()
  try {
    writeFileSync(join(fx.dataDir, 'pricing.json'), priceSnapshot())
    const { stdout, code } = await fx.run(['--format', 'csv', '--by', 'provider', '--cost'])
    expect(code).toBe(0)

    // 同上：时刻的形状而不是具体值（bun test 与子进程的 TZ 不同）
    expect(stdout.includes('# cost (单价来源: 本地单价快照（同步于 ')).toBe(true)
    expect(stdout.includes('dimension,key,currency,amountMicro,tokens')).toBe(true)
    expect(stdout.includes(`provider,paid,CNY,${PAID_AMOUNT_MICRO},${PAID_TOKENS}`)).toBe(true)

    // 未计价节：这把「没配到价」写成 token 数，而不是金额 0。
    // 各项都是**该分组键自己**的数（不是全局合计）：free 这一组 1000 条全未计价。
    expect(stdout.includes('# cost-unpriced')).toBe(true)
    const unpriced = stdout.slice(stdout.indexOf('# cost-unpriced'))
    expect(unpriced.includes(`provider,free,${FREE_TOKENS},${FREE_TOKENS},1.000000`)).toBe(true)

    // 金额节里**不允许**出现未计价的键：一行 `...,0` 与「真的不花钱」在机器读来一样
    const amountSection = stdout.slice(stdout.indexOf('# cost ('), stdout.indexOf('# cost-unpriced'))
    expect(amountSection.includes('free')).toBe(false)

    // 全局合计与比例：`--top` 截断后消费方自己相加会得到错的数，所以必须显式给出。
    expect(
      stdout.includes(
        `snapshot,${new Date(SYNCED_MS).toISOString()},${PAID_TOKENS},${FREE_TOKENS},` +
          `${PAID_TOKENS + FREE_TOKENS},0.782609,0.217391,`,
      ),
    ).toBe(true)
  } finally {
    fx.cleanup()
  }
})

test('没有快照时退回内置种子价，并把原因与「不是账单」打成显式告警', async () => {
  const fx = setup()
  try {
    const { stdout, code } = await fx.run(['--by', 'provider', '--cost'])
    expect(code).toBe(0)
    expect(stdout.includes('单价来源: 内置种子价')).toBe(true)
    // 🚨 必须显式告警：退回内置价会让金额与看板不一致，而两者都「看起来正常」。
    expect(stdout.includes('⚠ 还没有同步过单价快照')).toBe(true)
    expect(stdout.includes('单价快照解析失败')).toBe(false)
    // 内置价只覆盖 deepseek-official：本例两个 provider 一条都配不上 → 全部未计价
    expect(stdout.includes('未计价 100.0%（4,600 Token）')).toBe(true)
    expect(stdout.includes('合计: 未计价')).toBe(true)
    expect(stdout.includes('未配单价: free/free-model、paid/paid-model')).toBe(true)
  } finally {
    fx.cleanup()
  }
})

test('快照坏掉时整份拒绝并说明原因，绝不半份生效', async () => {
  const fx = setup()
  try {
    writeFileSync(join(fx.dataDir, 'pricing.json'), '{ 这不是 JSON')
    const { stdout, code } = await fx.run(['--format', 'json', '--by', 'provider', '--cost'])
    expect(code).toBe(0)
    const cost = JSON.parse(stdout).cost
    // 半份单价表会让费用看起来正常却按内置价算，而 pricingSyncedAt 还显示同步成功 ——
    // 那是最难排查的一种，所以解析失败一律整份拒绝。
    expect(cost.pricing).toEqual({ pricingSource: 'builtin', pricingSyncedAt: null })
    expect(cost.totals.costs).toEqual([])
    expect(cost.totals.unpricedTokens).toBe(PAID_TOKENS + FREE_TOKENS)
  } finally {
    fx.cleanup()
  }
})

test('--pricing-file 指定快照路径，数据目录下的同名文件不再被读', async () => {
  const fx = setup()
  try {
    writeFileSync(join(fx.dataDir, 'pricing.json'), '{ 坏的那一份')
    const custom = join(fx.home, 'custom-prices.json')
    writeFileSync(custom, priceSnapshot())
    const { stdout, code } = await fx.run([
      '--format', 'json', '--by', 'provider', '--cost', '--pricing-file', custom,
    ])
    expect(code).toBe(0)
    const cost = JSON.parse(stdout).cost
    expect(cost.pricing.pricingSource).toBe('snapshot')
    expect(cost.totals.costs[0].amountMicro).toBe(PAID_AMOUNT_MICRO)
  } finally {
    fx.cleanup()
  }
})

test('单价快照被读取而不是被改写：--cost 只读，不改动 pricing.json 一个字节', async () => {
  const fx = setup()
  try {
    const path = join(fx.dataDir, 'pricing.json')
    writeFileSync(path, priceSnapshot())
    const before = readFileSync(path, 'utf8')
    await fx.run(['--format', 'json', '--cost'])
    expect(readFileSync(path, 'utf8')).toBe(before)
  } finally {
    fx.cleanup()
  }
})