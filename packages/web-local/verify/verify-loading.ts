/**
 * 取数编排验证：点分组维度页签**不许整页闪一下**。
 *
 * 运行： bun run verify/verify-loading.ts
 *
 * ## 为什么单独有这么一个脚本
 *
 * 「闪动」这类回归**不报错**：类型检查、SSR 渲染、数据层断言全绿，
 * 只是页面每次点击都塌一下再撑开。所以这里把真实的 `useUsageStats()`
 * （经 Vite SSR 管线加载，`@/` 别名照常生效）跑起来，用假的 `fetch`
 * 数请求、控时序，钉住四条：
 *
 * 1. 首屏 / 换时间窗 → overview + series + breakdown 各一次；
 * 2. **只**换分组维度 → 只有 breakdown 一次，而且 `summary`（卡片 / 图表 / 来源）
 *    的对象引用**一个都没换** —— 「不重画」这件事的机器可验证形态；
 * 3. 任何一轮进行中都不闪回首屏骨架（`loading` 一旦解除就不再置真）；
 * 4. 在飞时筛选又变了 → 旧筛选带回来的结果**丢掉**，不写进页面
 *    （否则页签已是「项目」，表格里先画一遍「模型」的行，再换一次 = 闪两下）。
 *
 * ⚠️ 这里断言的是**编排**，不是像素。淡化 / 「更新中…」那些呈现由
 *   `verify-render.ts` 的模板断言兜住。
 */
import { createServer } from 'vite'
import { resolve } from 'node:path'

// ⚠️ 这里**不给 `globalThis.document` 造替身**：Vue 的 runtime-dom 看到
//   `typeof document !== 'undefined'` 就会去 `document.createElement('template')`，
//   半个替身会让它直接崩在 import 阶段。本脚本只跑用户发起的取数
//   （`onMounted` 在组件外不执行 ⇒ 3 秒轮询那条读 `document.hidden` 的路径不会被走到）。

const server = await createServer({
  root: resolve(import.meta.dir, '..'),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
})

const failures: string[] = []
function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures.push(label)
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}

/** 每个维度回一组**可分辨**的行，用来断言「表格里现在是哪个维度的数」。 */
function bodyFor(url: string): unknown {
  const parsed = new URL(url, 'http://127.0.0.1')
  if (parsed.pathname.endsWith('/api/local/refresh')) return { ok: true }
  if (parsed.pathname.endsWith('/api/local/stats/overview')) {
    return {
      range: { from: null, to: null, label: '今天' },
      sources: { sessionsRoots: ['/root/a'], missingRoots: [], dataDir: null },
      totalTokens: 100,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 85,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      calls: 3,
      sessions: 1,
      cacheHitRate: 85 / 95,
      cacheLeverage: 8.5,
      avgTokensPerCall: 100 / 3,
      scannedAt: Date.now(),
      cached: false,
    }
  }
  if (parsed.pathname.endsWith('/api/local/stats/series')) {
    const bucket = parsed.searchParams.get('bucket') ?? 'day'
    return {
      bucket,
      points: ['A', 'B'].map((tag) => ({
        bucket: tag,
        totalTokens: 50,
        inputTokens: 5,
        outputTokens: 5,
        cacheReadTokens: 40,
        cacheWriteTokens: 0,
        calls: 1,
        cacheHitRate: 40 / 45,
      })),
      scannedAt: Date.now(),
      cached: false,
    }
  }
  if (parsed.pathname.endsWith('/api/local/stats/breakdown')) {
    // 行键里带维度：`provider-row` / `model-row` / …
    const by = parsed.searchParams.get('by') ?? 'provider-model'
    return {
      rows: [
        {
          key: `${by}-row`,
          totalTokens: 100,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 85,
          cacheWriteTokens: 0,
          calls: 3,
          cacheHitRate: 85 / 95,
        },
      ],
    }
  }
  throw new Error(`未预期的请求：${url}`)
}

// —— 假的 fetch：记录每个请求；`auto` 立即回，`manual` 挂起等测试手动放行 ——
let mode: 'auto' | 'manual' = 'auto'
let failNext = false
const log: string[] = []
const outstanding: { url: string; send: () => void }[] = []

function respond(url: string): Response {
  if (failNext) return new Response(JSON.stringify({ reason: '内部错误' }), { status: 500 })
  return new Response(JSON.stringify(bodyFor(url)), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

globalThis.fetch = ((input: unknown) => {
  const url = String(input)
  log.push(url)
  if (mode === 'auto') return Promise.resolve(respond(url))
  return new Promise<Response>((resolve) => {
    outstanding.push({
      url,
      send: () => {
        const response = respond(url)
        // 手动模式下按 URL 现算，避免每次放行都改动全局 `failNext` 的语义
        resolve(response)
      },
    })
  })
}) as typeof fetch

/** 放行一个挂起的请求（未挂起则抛错）。 */
function release(): void {
  const next = outstanding.shift()
  if (!next) throw new Error('没有挂起的请求可放行')
  next.send()
}

/** 放行当前全部挂起的请求（一轮取数的几个请求是并发发出的）。 */
function releaseAll(): void {
  while (outstanding.length > 0) release()
}

/** 轮询到条件成立（宏任务间隔，保证 Vue 的微任务调度与 fetch 链都跑完）。 */
async function until(label: string, predicate: () => boolean, rounds = 200): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (predicate()) return
    await new Promise((done) => setTimeout(done, 0))
  }
  throw new Error(`等待超时：${label}`)
}

try {
  const { useUsageStats } = (await server.ssrLoadModule(
    '/src/composables/useUsageStats.ts',
  )) as { useUsageStats: () => any }

  const originalWarn = console.warn
  /**
   * 建一个统计编排实例。
   *
   * `useUsageStats()` 在组件外调用：`onMounted` / `onUnmounted` 会各警告一句。
   * 它们在这里是**预期**的（没有组件实例，也就不起 3 秒轮询）—— 只静音这两条。
   */
  function createStats(): any {
    console.warn = (...args: unknown[]): void => {
      if (String(args[0] ?? '').includes('no active component instance')) return
      originalWarn(...args)
    }
    const instance = useUsageStats()
    console.warn = originalWarn
    return instance
  }

  const stats = createStats()

  // ── ① 首屏一轮（等价于 onMounted 的那次 `load('all')`） ──────────────────
  log.length = 0
  await stats.hardRefresh()
  check(
    '首屏一轮取数：overview + series + breakdown 各一次（外加 refresh 回执）',
    log.length === 4 &&
      log.some((u) => u.includes('/stats/overview')) &&
      log.some((u) => u.includes('/stats/series')) &&
      log.some((u) => u.includes('/stats/breakdown')),
    log.join(' | '),
  )
  check('首屏结束后解除骨架', stats.loading.value === false)
  check('首屏结束后不再显示「处理中」', stats.busy.value === 'idle', stats.busy.value)
  check('明细行来自 breakdown', stats.rows.value[0]?.key === 'provider-model-row')
  check('卡片数据来自 overview', stats.summary.value.metrics[0]?.value === '100', stats.summary.value.metrics[0]?.value)

  // ── ② 只换分组维度：一个请求，且卡片 / 图表**一个字节都不动** ────────────
  const summaryBefore = stats.summary.value
  log.length = 0
  stats.groupBy.value = 'provider'
  await until('换维度那一轮发出', () => log.length === 1)
  await until('换维度那一轮结束', () => stats.busy.value === 'idle')
  check(
    '换分组维度只发 breakdown 一个请求（不重取 overview / series）',
    log.length === 1 && log[0]!.includes('/stats/breakdown'),
    log.join(' | '),
  )
  check('请求用的是刚选中的维度', log[0]!.includes('by=provider'), log[0])
  check(
    '★ 换维度不重建 summary（卡片 / 图表不重画 = 不闪）',
    stats.summary.value === summaryBefore,
  )
  check('★ 换维度不闪回首屏骨架', stats.loading.value === false)
  check('明细行换成了新维度', stats.rows.value[0]?.key === 'provider-row')

  // ── ③ 换时间窗：三个接口都取，但**全程不闪回骨架** ──────────────────────
  mode = 'manual'
  log.length = 0
  stats.timeRange.value = 'week'
  await until('换时间窗那一轮发出', () => log.length === 3)
  check('在飞期间就显示「处理中」，且范围是 all（卡片 / 图表一起换）', stats.busy.value === 'all')
  check('★ 换时间窗期间旧数字留在原地（不闪回骨架）', stats.loading.value === false)
  check(
    '换时间窗取三个接口，且 series 按天分桶（week → day）',
    log.filter((u) => u.includes('/stats/series')).every((u) => u.includes('bucket=day')),
    log.join(' | '),
  )
  for (let i = 0; i < 3; i += 1) release()
  await until('换时间窗那一轮结束', () => stats.busy.value === 'idle')
  check('换时间窗后 summary 被重建', stats.summary.value !== summaryBefore)

  // ── ④ 在飞时又切了维度：旧筛选的结果必须丢掉（否则「闪两下」） ───────────
  log.length = 0
  stats.groupBy.value = 'model'
  await until('model 那一轮发出', () => outstanding.length === 1)
  stats.groupBy.value = 'project'
  await new Promise((done) => setTimeout(done, 0))
  check(
    '在飞时再切维度：只记一个「还欠一轮」，不叠发第二个请求',
    outstanding.length === 1 && log.length === 1,
    `在飞 ${outstanding.length} / 请求 ${log.length}`,
  )
  release() // 放行 model 那一轮的响应
  await until('被判过期后补跑 project 那一轮', () => log.length === 2)
  check('★ 过期维度的行没有写进页面（表格里仍是上一轮的 provider）', stats.rows.value[0]?.key === 'provider-row')
  check('补跑的那一轮用的是最新维度', log[1]!.includes('by=project'), log[1])
  release()
  await until('project 那一轮结束', () => stats.busy.value === 'idle' && stats.rows.value[0]?.key === 'project-row')
  check('最终落在最新维度上', stats.rows.value[0]?.key === 'project-row')

  // ── ⑤ 取数失败：解除骨架并给出错误（不许永远停在骨架上） ────────────────
  log.length = 0
  failNext = true
  stats.timeRange.value = 'month'
  await until('换时间窗那一轮发出', () => log.length === 3)
  check('失败时也进入「处理中」', stats.busy.value === 'all')
  for (let i = 0; i < 3; i += 1) release()
  await until('失败那一轮结束', () => stats.busy.value === 'idle')
  check('失败后解除骨架（页面显示报错而不是永远扫描中）', stats.loading.value === false)
  check('失败原因被带出来', (stats.error.value ?? '').length > 0, String(stats.error.value))

  // ── ⑥ 首屏那一轮还在飞时切维度：被作废的整轮必须由补跑的那一轮接管 ──────
  //   这是上面几条的边界：`rows` 那一轮**只**取明细，如果它顶替掉被作废的首屏整轮，
  //   卡片与图表就永远停在 0（错误也已清掉）—— 看起来像「这段时间没有用量」。
  failNext = false
  log.length = 0
  const fresh = createStats()
  fresh.timeRange.value = 'week' // 起一轮 all（首屏那一轮）
  await until('首屏那一轮发出', () => log.length === 3)
  fresh.groupBy.value = 'provider' // 首屏还在飞时点维度页签
  await new Promise((done) => setTimeout(done, 0))
  check(
    '首屏在飞时切维度：不叠发请求（首屏那三个还挂着）',
    outstanding.length === 3 && log.length === 3,
    `在飞 ${outstanding.length} / 请求 ${log.length}`,
  )
  releaseAll() // 首屏那一轮回来 —— 此时它已被判过期
  await until('★ 补跑的是整轮（overview + series + breakdown）', () => log.length === 6)
  const followUp = log.slice(3)
  check(
    '★ 补跑的那一轮含 overview（否则卡片停在 0 = 看起来没有用量）',
    followUp.some((u) => u.includes('/stats/overview')),
    followUp.join(' | '),
  )
  check(
    '补跑的那一轮含 series 与 breakdown',
    followUp.some((u) => u.includes('/stats/series')) &&
      followUp.some((u) => u.includes('/stats/breakdown')),
    followUp.join(' | '),
  )
  releaseAll()
  await until(
    '补跑那一轮结束',
    () => fresh.busy.value === 'idle' && fresh.rows.value[0]?.key === 'provider-row',
  )
  check('补跑之后卡片真的有数', fresh.summary.value.metrics[0]?.value === '100', fresh.summary.value.metrics[0]?.value)
  check('补跑之后明细用的是最新维度', fresh.rows.value[0]?.key === 'provider-row')

  console.log('')
  if (failures.length > 0) {
    console.error(`共 ${failures.length} 项断言失败：`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
  } else {
    console.log('取数编排断言全部通过。')
  }
} finally {
  await server.close()
}
