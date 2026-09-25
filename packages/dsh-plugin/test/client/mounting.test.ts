/**
 * 浏览器半「挂载点」的测试。
 *
 * ★ 这个文件存在的唯一理由是**这类错误完全静默**：
 *
 * - slot 名字写错 → `slots.inject()` 永不回调 → 面板不出现，控制台一句话都没有。
 * - 两个面板各建一个 store → 取数翻倍（Node 宿主上是真的重扫一遍日志）。
 * - `inject` 服务名写成包名 → fiber 永远等不到依赖 → 同样静默。
 *
 * 三者都不会红、不会抛、不会有日志，所以只能靠断言钉住。
 */

import { describe, expect, test } from 'bun:test'

import { apply, BADGE_ORDER, DOCK_ORDER, DOCK_SLOT, HEADER_SLOT, inject } from '../../src/client/index.js'
import type { UsageStore } from '../../src/client/store.js'

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

describe('apply() 的装配', () => {
  test('两个挂载点各注册一次，顺序与 order 稳定', () => {
    const { slots, recorded } = fakeSlots()
    apply({ slots } as never)

    expect(recorded.map((r) => r.slot)).toEqual([DOCK_SLOT, HEADER_SLOT])
    expect(recorded.map((r) => r.order)).toEqual([DOCK_ORDER, BADGE_ORDER])
    // list 类 slot 必须有格子 id，否则同 slot 里两条注册会互相顶掉
    expect(recorded.every((r) => r.id === 'token-report')).toBe(true)
    expect(recorded.every((r) => typeof r.component === 'function')).toBe(true)
  })

  test('★ 两个面板共用同一个 store（取数只做一次）', () => {
    const { slots, recorded } = fakeSlots()
    apply({ slots } as never)

    const stores = recorded.map((r) => r.face()['usage'] as UsageStore)
    expect(stores[0]).toBe(stores[1])
    expect(typeof stores[0]?.getSnapshot).toBe('function')
  })

  test('slots 服务拿不到时只告警、不抛错（浏览器里缺服务不该白屏）', () => {
    const warnings: string[] = []
    expect(() =>
      apply({
        get: () => undefined,
        logger: { warn: (m: string) => warnings.push(m) },
      } as never),
    ).not.toThrow()
    expect(warnings.some((w) => w.includes('slots'))).toBe(true)
  })

  test('同时支持 ctx.get("slots")（已安装的第三方插件就是这么取服务的）', () => {
    const { slots, recorded } = fakeSlots()
    apply({ get: (name: string) => (name === 'slots' ? slots : undefined) } as never)
    expect(recorded.length).toBe(2)
  })

  test('注册后打一条 info，便于排障时确认「到底装上没有」', () => {
    const { slots } = fakeSlots()
    const logs: string[] = []
    apply({ slots, logger: { info: (m: string) => logs.push(m) } } as never)
    expect(logs.some((l) => l.includes(DOCK_SLOT) && l.includes(HEADER_SLOT))).toBe(true)
  })
})
