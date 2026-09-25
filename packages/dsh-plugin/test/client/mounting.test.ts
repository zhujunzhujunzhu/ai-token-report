/**
 * 浏览器半「挂载点」的测试。
 *
 * ★ 这个文件存在的唯一理由是**这类错误完全静默**：
 *
 * - slot 名字写错 → `slots.inject()` 永不回调 → 面板不出现，控制台一句话都没有。
 * - 两个面板各建一个 store → 取数翻倍（Node 宿主上是真的重扫一遍日志）。
 * - `inject` 服务名写成包名 → fiber 永远等不到依赖 → 同样静默。
 * - **位置取不到就干脆不挂载** → 界面上什么都没有，而日志里只有一条 warn。
 *
 * 四者都不会红、不会抛、不会有日志（或只有一条容易被忽略的），所以只能靠断言钉住。
 *
 * ## 位置是从 HTTP 来的
 *
 * DSH 的客户端插件条目**拿不到**插件 config（见 `src/client/index.ts` 的说明），
 * 所以 `ui.position` 由宿主半经 `GET /api/tokenReport.config` 交给页面。
 * 于是「取配置失败」是本模块最需要被钉住的分支 —— 见文件末尾那一组用例。
 */

import { describe, expect, test } from 'bun:test'

import {
  apply,
  BADGE_ORDER,
  DOCK_ORDER,
  DOCK_SLOT,
  HEADER_SLOT,
  inject,
  resolveSurfaces,
  UI_CONFIG_TIMEOUT_MS,
} from '../../src/client/index.js'
import { UI_CONFIG_PATH, UI_DEFAULT_POSITION, type UiPosition } from '../../src/client/protocol.js'
import type { UsageStore, UsageStoreDeps } from '../../src/client/store.js'

/** 一条被记录下来的注册。 */
interface Recorded {
  slot: string
  order?: number
  id?: string
  component: unknown
  face: () => Record<string, unknown>
}

/** 假 slots 服务：记录注册，并立刻回调（模拟「slot 已声明」）。 */
function fakeSlots(): { slots: unknown; recorded: Recorded[] } {
  const recorded: Recorded[] = []
  const slots = {
    inject(_name: string, callback: () => unknown) {
      // ⚠️ 真框架里这个回调要等 slot 被**声明**之后才跑；
      //   这里立刻跑，等价于「宿主 UI 已经把 slot 声明好了」这一正常路径。
      callback()
      return () => {}
    },
    register(
      options: { name: string; id?: string; order?: number; inject?: () => Record<string, unknown> },
      component: unknown,
    ) {
      recorded.push({
        slot: options.name,
        ...(options.order !== undefined ? { order: options.order } : {}),
        ...(options.id !== undefined ? { id: options.id } : {}),
        component,
        face: options.inject ?? (() => ({})),
      })
      return () => {}
    },
  }
  return { slots, recorded }
}

/** 假配置通道：按给定位置作答，并记下被请求的地址。 */
function configFetch(
  position: UiPosition | 'error' | 'not-json' | 'status',
  options: { status?: number } = {},
): { fetch: UsageStoreDeps['fetch']; urls: string[] } {
  const urls: string[] = []
  const fetch: UsageStoreDeps['fetch'] = async (input) => {
    urls.push(input)
    if (position === 'error') throw new Error('Failed to fetch')
    if (position === 'status') {
      return { ok: false, status: options.status ?? 404, json: async () => ({}) }
    }
    if (position === 'not-json') {
      return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } }
    }
    return { ok: true, status: 200, json: async () => ({ position }) }
  }
  return { fetch, urls }
}

/** 跑一次装配，返回注册结果与日志。 */
async function mount(
  deps: { fetch?: UsageStoreDeps['fetch']; configTimeoutMs?: number } = {},
): Promise<{ recorded: Recorded[]; warnings: string[]; infos: string[] }> {
  const { slots, recorded } = fakeSlots()
  const warnings: string[] = []
  const infos: string[] = []
  await apply(
    { slots, logger: { info: (m: string) => infos.push(m), warn: (m: string) => warnings.push(m) } } as never,
    deps,
  )
  return { recorded, warnings, infos }
}

describe('★ slot 名字必须与 DSH 声明一致（写错是静默失效）', () => {
  test('两个字面量与 DSH 的 SlotMap 声明逐字相符', () => {
    // 权威声明：@deepseek-ai/dsh-client-ui-conversation
    //   lib/types/client/contract/slots.d.ts 里的 declare module ... interface SlotMap
    // 改动前请回去对一遍那一份；DSH 升级后名字若变，这里会红。
    expect(DOCK_SLOT).toBe('conversation.input.dock')
    expect(HEADER_SLOT).toBe('conversation.session.header.utilities')
  })

  test('inject 声明的是**服务名** slots，不是包名', () => {
    expect([...inject]).toEqual(['slots'])
  })
})

describe('★ 位置 → 挂载点（纯函数）', () => {
  test('dock（默认）只挂输入框上方的用量条', () => {
    expect(resolveSurfaces('dock')).toEqual([DOCK_SLOT])
  })

  test('header 只挂会话标题栏的胶囊', () => {
    expect(resolveSurfaces('header')).toEqual([HEADER_SLOT])
  })

  test('both 两个都挂，且顺序与 0.2.0 一致（dock 在前）', () => {
    expect(resolveSurfaces('both')).toEqual([DOCK_SLOT, HEADER_SLOT])
  })

  test('默认常量就是 dock（0.3.0 起的行为变更点）', () => {
    expect(UI_DEFAULT_POSITION).toBe('dock')
    expect(resolveSurfaces(UI_DEFAULT_POSITION)).toEqual([DOCK_SLOT])
  })
})

describe('apply() 的装配', () => {
  test('★ 默认（宿主说 dock）只注册一个挂载点，配置通道被请求一次', async () => {
    const channel = configFetch('dock')
    const { recorded, infos } = await mount({ fetch: channel.fetch })

    expect(channel.urls).toEqual([UI_CONFIG_PATH])
    expect(recorded.map((r) => r.slot)).toEqual([DOCK_SLOT])
    expect(recorded[0]?.order).toBe(DOCK_ORDER)
    // list 类 slot 必须有格子 id，否则同 slot 里两条注册会互相顶掉
    expect(recorded.every((r) => r.id === 'token-report')).toBe(true)
    expect(recorded.every((r) => typeof r.component === 'function')).toBe(true)
    expect(infos.some((l) => l.includes(DOCK_SLOT))).toBe(true)
  })

  test('header：只注册标题栏胶囊', async () => {
    const { fetch } = configFetch('header')
    const { recorded } = await mount({ fetch })
    expect(recorded.map((r) => r.slot)).toEqual([HEADER_SLOT])
    expect(recorded[0]?.order).toBe(BADGE_ORDER)
  })

  test('★ both：两个面板共用同一个 store（取数只做一次）', async () => {
    const { fetch } = configFetch('both')
    const { recorded } = await mount({ fetch })

    expect(recorded.map((r) => r.slot)).toEqual([DOCK_SLOT, HEADER_SLOT])
    expect(recorded.map((r) => r.order)).toEqual([DOCK_ORDER, BADGE_ORDER])
    const stores = recorded.map((r) => r.face()['usage'] as UsageStore)
    expect(stores[0]).toBe(stores[1])
    expect(typeof stores[0]?.getSnapshot).toBe('function')
  })

  test('注册后打一条 info，列出真正挂上的挂载点', async () => {
    const { fetch } = configFetch('header')
    const { infos } = await mount({ fetch })
    expect(infos.some((l) => l.includes('用量面板已挂载') && l.includes(HEADER_SLOT))).toBe(true)
  })

  test('slots 服务拿不到时只告警、不抛错（浏览器里缺服务不该白屏）', async () => {
    const warnings: string[] = []
    await apply({
      get: () => undefined,
      logger: { warn: (m: string) => warnings.push(m) },
    } as never)
    expect(warnings.some((w) => w.includes('slots'))).toBe(true)
  })

  test('slots 拿不到时**不去请求**配置（连 slots 都没有就不必问位置）', async () => {
    const channel = configFetch('dock')
    await apply({ get: () => undefined } as never, { fetch: channel.fetch })
    expect(channel.urls).toEqual([])
  })

  test('同时支持 ctx.get("slots")（已安装的第三方插件就是这么取服务的）', async () => {
    const { slots, recorded } = fakeSlots()
    const { fetch } = configFetch('both')
    await apply({ get: (name: string) => (name === 'slots' ? slots : undefined) } as never, { fetch })
    expect(recorded.length).toBe(2)
  })

  test('★ 清理在「取配置」之前就注册好（取配置期间被卸载也不漏定时器）', async () => {
    const { slots, recorded } = fakeSlots()
    const effects: (() => (() => void) | void)[] = []
    let release: (() => void) | undefined
    // 宿主挂着不回：apply 会停在这个 await 上
    const fetch: UsageStoreDeps['fetch'] = () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, status: 200, json: async () => ({ position: 'both' }) })
      })

    const pending = apply(
      { slots, effect: (cb: () => (() => void) | void) => void effects.push(cb) } as never,
      { fetch },
    )
    // apply 是 async，但 await 之前的代码是**同步**跑完的 —— 所以这里就能断言
    expect(effects.length).toBe(1)
    expect(recorded.length).toBe(0) // 位置还没回来，一个 slot 都还没注册

    release?.()
    await pending
    expect(recorded.length).toBe(2)
  })
})

describe('★ 位置取不到 → 回退默认位置，但**面板照常挂载**', () => {
  test('宿主是旧版本（配置路由 404）→ dock + 一条 warn', async () => {
    const channel = configFetch('status', { status: 404 })
    const { recorded, warnings } = await mount({ fetch: channel.fetch })
    expect(recorded.map((r) => r.slot)).toEqual([DOCK_SLOT])
    expect(warnings.some((w) => w.includes('404') && w.includes(UI_DEFAULT_POSITION))).toBe(true)
  })

  test('宿主未通过鉴权（401）→ 同样 dock，而不是不挂载', async () => {
    const channel = configFetch('status', { status: 401 })
    const { recorded, warnings } = await mount({ fetch: channel.fetch })
    expect(recorded.map((r) => r.slot)).toEqual([DOCK_SLOT])
    expect(warnings.some((w) => w.includes('401'))).toBe(true)
  })

  test('网络层直接抛错 → dock，且不把异常抛给框架（抛出去 = 插件不激活）', async () => {
    const channel = configFetch('error')
    const { recorded, warnings } = await mount({ fetch: channel.fetch })
    expect(recorded.map((r) => r.slot)).toEqual([DOCK_SLOT])
    expect(warnings.some((w) => w.includes('Failed to fetch'))).toBe(true)
  })

  test('返回的不是 JSON（SPA 兜底 HTML）→ dock', async () => {
    const channel = configFetch('not-json')
    const { recorded, warnings } = await mount({ fetch: channel.fetch })
    expect(recorded.map((r) => r.slot)).toEqual([DOCK_SLOT])
    expect(warnings).toEqual([]) // 垃圾载荷不算「取不到」，静默回退即可
  })

  test('载荷缺字段 / 值不认识 → dock，不抛错', async () => {
    for (const body of [{}, { position: 'right' }, { position: 123 }, null, 'dock']) {
      const fetch: UsageStoreDeps['fetch'] = async () => ({ ok: true, status: 200, json: async () => body })
      const { recorded } = await mount({ fetch })
      expect(recorded.map((r) => r.slot)).toEqual([DOCK_SLOT])
    }
  })

  test('取配置超时（宿主挂着不回）→ 到点即回退 dock，不无限等', async () => {
    const fetch: UsageStoreDeps['fetch'] = (_input, init) =>
      new Promise((_resolve, reject) => {
        // 宿主永不回应，只有 abort 能让它结束 —— 模拟被中间层吞掉的请求
        init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')))
      })
    const { recorded, warnings } = await mount({ fetch, configTimeoutMs: 5 })
    expect(recorded.map((r) => r.slot)).toEqual([DOCK_SLOT])
    expect(warnings.some((w) => w.includes('aborted'))).toBe(true)
    // 正常路径的上限就是导出的那个常量，别让它悄悄变成 0 或很大
    expect(UI_CONFIG_TIMEOUT_MS).toBeGreaterThan(0)
  })
})