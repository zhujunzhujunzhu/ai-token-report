/**
 * 展示格式的测试。
 *
 * 这些函数看着「随手就能写对」，但它们决定了面板上**唯一可见的东西**：
 * `12.34M` 与 `12.3M` 的差别在评审时会被当成「数字算错了」报上来。
 * 所以连进位边界一起钉住。
 */

import { describe, expect, test } from 'bun:test'

import {
  fmtAge,
  fmtClock,
  fmtCompact,
  fmtInt,
  fmtLeverage,
  fmtPct,
  shortBucket,
  sourceLabel,
} from '../../src/client/format.js'
import { UI_ALL_SOURCES, usageSourceLabel } from '../../src/client/protocol.js'

describe('紧凑数字', () => {
  test('1e9 / 1e6 / 1e3 各自进位', () => {
    expect(fmtCompact(2_392_609_771)).toBe('2.39B')
    expect(fmtCompact(12_345_678)).toBe('12.35M')
    expect(fmtCompact(2_312_474_995)).toBe('2.31B')
    expect(fmtCompact(1_234)).toBe('1.2K')
    expect(fmtCompact(999)).toBe('999')
    expect(fmtCompact(0)).toBe('0')
  })

  test('临界值取哪一档（999999 仍是 K，1000000 才进 M）', () => {
    expect(fmtCompact(999_999)).toBe('1000.0K')
    expect(fmtCompact(1_000_000)).toBe('1.00M')
  })

  test('全量数字带千分位', () => {
    expect(fmtInt(2_392_609_771)).toBe('2,392,609,771')
    expect(fmtInt(0)).toBe('0')
  })
})

describe('比率与倍数', () => {
  test('百分比入参是 0~1 的比率，不是已经乘过 100 的数', () => {
    expect(fmtPct(0.943)).toBe('94.3%')
    expect(fmtPct(0.9705, 2)).toBe('97.05%')
    expect(fmtPct(0)).toBe('0.0%')
  })

  test('⚠️ 0.9705 保留一位得到 97.0% 而不是 97.1%（二进制表示，不是 bug）', () => {
    // 0.9705 在双精度下略小于十进制字面量，乘 100 之后落到 97.05 的下方，
    // 于是 toFixed(1) 向下进位。这与 core/format.ts 的 fmtPct 行为**一致**
    // （都是先乘 100 再 toFixed），所以不要为了「看起来更对」在这里加
    // 0.0000001 之类的补偿 —— 那会让面板与终端对同一个数给出两种写法。
    expect(fmtPct(0.9705)).toBe('97.0%')
  })

  test('杠杆保留一位小数', () => {
    expect(fmtLeverage(32.85)).toBe('32.9x')
    expect(fmtLeverage(0)).toBe('0.0x')
  })
})

describe('相对时间', () => {
  const t0 = 1_700_000_000_000

  test('按秒 / 分 / 时 / 天分段', () => {
    expect(fmtAge(t0, t0)).toBe('刚刚')
    expect(fmtAge(t0 + 3_000, t0)).toBe('刚刚')
    expect(fmtAge(t0 + 12_000, t0)).toBe('12 秒前')
    expect(fmtAge(t0 + 3 * 60_000, t0)).toBe('3 分钟前')
    expect(fmtAge(t0 + 5 * 3_600_000, t0)).toBe('5 小时前')
    expect(fmtAge(t0 + 3 * 86_400_000, t0)).toBe('3 天前')
  })

  test('时钟漂移（now < then）不产生负数', () => {
    expect(fmtAge(t0, t0 + 5_000)).toBe('刚刚')
  })

  test('fmtClock 给出本地时钟字符串', () => {
    expect(fmtClock(t0)).toBe(new Date(t0).toLocaleTimeString())
  })
})

describe('来源标签：降级必须看得出来', () => {
  test('三种来源各有明确说法', () => {
    expect(sourceLabel('local-db')).toBe('本机 SQLite 库')
    expect(sourceLabel('scan')).toBe('直扫会话日志')
    expect(sourceLabel('none')).toBe('未找到会话日志')
  })

  test('未知来源原样透出，不吞掉', () => {
    expect(sourceLabel('something-new')).toBe('something-new')
  })
})

/**
 * ★ **用量来源**（哪个客户端产生的用量）的展示名。
 *
 * 🚨 与上面的 `sourceLabel` 是**两件事**：那个说的是数据通路（库 / 直扫），
 *   这个说的是客户端（DSH / Codex / …）。
 *
 * 这份表与部门看板 `web-portal/src/types/portal.ts` 的 `SOURCE_LABELS` **逐字一致**
 * （浏览器半进不去 workspace 包，所以只能在插件里再写一份）。这里断言的是
 * 「写下来的那一份」，两处同时改才需要动它 —— 它挡的是**单边**改动。
 */
describe('用量来源标签（下拉里的文案）', () => {
  test('六个已注册来源各有说法，且与看板用词一致', () => {
    expect(usageSourceLabel('dsh')).toBe('DSH')
    expect(usageSourceLabel('codex')).toBe('Codex')
    expect(usageSourceLabel('claude-code')).toBe('Claude Code')
    expect(usageSourceLabel('trae')).toBe('Trae')
    expect(usageSourceLabel('trae-cn')).toBe('Trae CN')
    expect(usageSourceLabel('workbuddy')).toBe('WorkBuddy')
  })

  test('未知来源原样显示 id（猜一个名字更容易误导）', () => {
    expect(usageSourceLabel('new-client')).toBe('new-client')
  })

  test('「全部来源」那一项的 value 是空串：与「不发 source 参数」是同一个意思', () => {
    expect(UI_ALL_SOURCES).toBe('')
  })
})

describe('趋势点的轴标签', () => {
  test('小时粒度取小时，日粒度取月-日', () => {
    expect(shortBucket('2026-09-24T14')).toBe('14时')
    expect(shortBucket('2026-09-24')).toBe('9-24')
  })

  test('认不出的形状原样返回（不猜）', () => {
    expect(shortBucket('2026-09')).toBe('2026-09')
  })
})
