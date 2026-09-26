/**
 * 日期文本逻辑的单测。
 *
 * 这些函数是「使用者敲的字」与「发给宿主的区间」之间唯一的翻译层 ——
 * 组件里的同类逻辑只能靠人眼看，所以它们必须被逐条钉住：
 * 认错一个格式 = 使用者以为自己选了 10 月 8 日，面板却在统计别的区间。
 */

import { describe, expect, test } from 'bun:test'
import { dayKey, fieldsToRange, inclusiveDays, parseDayText, selectionHint, shortDay, triggerLabel, triggerTitle } from '../../src/client/date-text.js'

describe('parseDayText', () => {
  test('认常见的几种写法，一律收敛成 YYYY-MM-DD', () => {
    expect(parseDayText('2026-09-21')).toBe('2026-09-21')
    expect(parseDayText('2026-9-1')).toBe('2026-09-01')
    expect(parseDayText('2026/9/1')).toBe('2026-09-01')
    expect(parseDayText('2026.9.1')).toBe('2026-09-01')
    expect(parseDayText('2026年9月1日')).toBe('2026-09-01')
    expect(parseDayText('  2026-09-01  ')).toBe('2026-09-01')
    expect(parseDayText('20260901')).toBe('2026-09-01')
  })

  test('★ 格式对但日期不存在 → 不认（复用 validDateRange，不另写一份判据）', () => {
    expect(parseDayText('2026-02-31')).toBeUndefined()
    expect(parseDayText('2026-13-01')).toBeUndefined()
    expect(parseDayText('2026-00-10')).toBeUndefined()
    expect(parseDayText('2026-09-31')).toBeUndefined()
    // 2024 是闰年，2026 不是
    expect(parseDayText('2024-02-29')).toBe('2024-02-29')
    expect(parseDayText('2026-02-29')).toBeUndefined()
  })

  test('认不出来的输入返回 undefined（空、半截、乱写）', () => {
    for (const text of ['', '   ', '2026', '2026-09', '9/1', '昨天', '2026-9-1-1', '26-09-01']) {
      expect(parseDayText(text)).toBeUndefined()
    }
  })
})

describe('区间与天数', () => {
  test('包含起止两天', () => {
    expect(inclusiveDays('2026-09-12', '2026-09-12')).toBe(1)
    expect(inclusiveDays('2026-09-12', '2026-10-06')).toBe(25)
    expect(inclusiveDays('2026-09-30', '2026-10-01')).toBe(2)
  })

  test('跨夏令时的两个日期不会差一天（用 UTC 正午做差）', () => {
    // 北美 2026-03-08 是夏令时切换日
    expect(inclusiveDays('2026-03-07', '2026-03-09')).toBe(3)
  })

  test('fieldsToRange 只在两行都合法且顺序对时给出区间', () => {
    expect(fieldsToRange({ since: '2026-09-12', until: '2026-10-06' })).toEqual({ since: '2026-09-12', until: '2026-10-06' })
    expect(fieldsToRange({ since: '2026/9/12', until: '2026年10月6日' })).toEqual({ since: '2026-09-12', until: '2026-10-06' })
    expect(fieldsToRange({ since: '2026-10-06', until: '2026-09-12' })).toBeUndefined()
    expect(fieldsToRange({ since: '2026-09-12', until: '' })).toBeUndefined()
    expect(fieldsToRange({ since: '', until: '' })).toBeUndefined()
  })
})

describe('selectionHint', () => {
  test('四种状态各有各的说法，非法时说清错在哪', () => {
    expect(selectionHint({ since: '', until: '' })).toEqual({ text: '先选开始，再选结束', error: false })
    expect(selectionHint({ since: '2026-09-12', until: '' })).toEqual({ text: '还需要结束日期', error: false })
    expect(selectionHint({ since: '', until: '2026-09-12' })).toEqual({ text: '还需要开始日期', error: false })
    expect(selectionHint({ since: '2026-09-12', until: '2026-10-06' })).toEqual({ text: '共 25 天', error: false })
    expect(selectionHint({ since: '2026-9-12', until: '2026-13-01' })).toEqual({ text: '结束日期格式应为 2026-09-21', error: true })
    expect(selectionHint({ since: '2026-9-12', until: '2026-10-06' })).toEqual({ text: '共 25 天', error: false })
  })

  test('★ 反向区间要报错而不是静默禁用按钮', () => {
    expect(selectionHint({ since: '2026-10-20', until: '2026-10-01' })).toEqual({ text: '开始日期不能晚于结束日期', error: true })
  })
})

describe('触发器文案', () => {
  test('只有当前生效的就是自定义区间时才显示区间', () => {
    const today = new Date('2026-09-25T10:00:00')
    expect(triggerLabel(undefined, false, today)).toBe('自定义')
    expect(triggerLabel({ since: '2026-09-12', until: '2026-10-06' }, false, today)).toBe('自定义')
    expect(triggerLabel(undefined, true, today)).toBe('自定义')
    // 同一年的区间省掉年份，跨年必须保留，否则「12-30 – 01-04」看不出方向
    expect(triggerLabel({ since: '2026-09-12', until: '2026-10-06' }, true, today)).toBe('09-12 – 10-06')
    expect(triggerLabel({ since: '2025-12-30', until: '2026-01-04' }, true, today)).toBe('2025-12-30 – 2026-01-04')
  })

  test('title 给出完整区间；未生效时只说这是自定义', () => {
    expect(triggerTitle({ since: '2026-09-12', until: '2026-10-06' }, true)).toBe('自定义范围：2026-09-12 至 2026-10-06')
    expect(triggerTitle({ since: '2026-09-12', until: '2026-10-06' }, false)).toBe('自定义日期范围')
    expect(triggerTitle(undefined, true)).toBe('自定义日期范围')
  })

  test('shortDay 只在需要时带年份', () => {
    expect(shortDay('2026-09-12', false)).toBe('09-12')
    expect(shortDay('2026-09-12', true)).toBe('2026-09-12')
  })
})

describe('dayKey', () => {
  test('★ 用本地日历取值，不用 toISOString（那是 UTC，会整体错一天）', () => {
    expect(dayKey(new Date('2026-09-12T12:00:00'))).toBe('2026-09-12')
    // 本地 00:30 在 UTC 下是前一天：这里必须仍是 12 日
    expect(dayKey(new Date(2026, 8, 12, 0, 30))).toBe('2026-09-12')
    expect(dayKey(new Date(2026, 0, 1, 23, 59))).toBe('2026-01-01')
  })
})