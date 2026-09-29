/**
 * 设置页上**给人看的那几句话**。
 *
 * 这些字符串不是装饰：使用者唯一的判断依据就是它们。两句话最容易说反：
 *
 * 1. 保存成功但上报**没**跑起来（未署名 / 部署关了上报 / 旧宿主需重启），
 *    却说成「已保存并开始上报」→ 人以为在跑，部门看板上却没有自己的数。
 * 2. 打开面板时把「未上报（原因）」说成「上报中」→ 同上，而且无处可查。
 *
 * 所以逐句钉住，包括「每 N 秒一批」里的那个 N 是不是真按毫秒换算过来的。
 */
import { describe, expect, test } from 'bun:test'

import { describeCurrent, describeSaved, intervalLabel } from '../../src/client/settings.js'
import { UI_DEFAULT_FLUSH_INTERVAL_MILLIS, type UiSettingsPayload } from '../../src/client/protocol.js'

/** 一份「配好了、正在跑」的读取载荷，各用例只改自己关心的字段。 */
function loaded(overrides: Partial<UiSettingsPayload> = {}): UiSettingsPayload {
  return {
    signed: true,
    name: '张三',
    group: '研发一部',
    baseUrl: 'http://127.0.0.1:8787',
    hasAppKey: true,
    locked: false,
    restartRequired: false,
    flushIntervalMillis: 10_000,
    position: 'dock',
    reporting: { enabled: true, endpoint: 'http://127.0.0.1:8787/api/v1/token-usage' },
    ...overrides,
  }
}

describe('保存后的提示：必须说清「到底在不在上报」', () => {
  test('★ 真的跑起来了 → 明确说「已保存并开始上报」并带上地址', () => {
    const text = describeSaved('张三', { enabled: true, endpoint: 'https://portal.example.com/api/v1/token-usage' }, false)
    expect(text).toContain('已保存并开始上报')
    expect(text).toContain('张三')
    expect(text).toContain('https://portal.example.com/api/v1/token-usage')
    expect(text).toContain('补报')
    // 说「开始上报」时不能同时提重启，否则用户不知道该不该重启
    expect(text).not.toContain('重启')
  })

  test('★ 没跑起来 → 不许说「已保存」就完事，必须给出原因', () => {
    for (const reason of ['尚未署名', '未配置 appKey', '部署关闭了上报']) {
      const text = describeSaved('张三', { enabled: false, endpoint: 'http://127.0.0.1:8787/api/v1/token-usage', reason }, false)
      expect(text).toContain('仍未启用')
      expect(text).toContain(reason)
      expect(text).not.toContain('开始上报')
    }
  })

  test('连 reporting 都没回（旧宿主）→ 说「原因未知」，不要假装成功', () => {
    const text = describeSaved('', undefined, false)
    expect(text).toContain('仍未启用')
    expect(text).toContain('原因未知')
  })

  test('★ 旧宿主没能就地生效 → 如实说需要重启，而不是「已开始上报」', () => {
    const text = describeSaved('张三', { enabled: true, endpoint: 'https://x/api/v1/token-usage' }, true)
    expect(text).toContain('重启 DSH')
    expect(text).not.toContain('开始上报')
  })
})

describe('打开面板时的状态说明', () => {
  test('★ 未署名 → 直说「只查看本机统计，不采集也不上报」', () => {
    const text = describeCurrent(loaded({
      signed: false, name: '', hasAppKey: false,
      reporting: { enabled: false, endpoint: 'http://127.0.0.1:8787/api/v1/token-usage', reason: '尚未署名' },
    }), undefined)
    expect(text).toContain('尚未配置 appKey')
    expect(text).toContain('不采集也不上报')
    expect(text).not.toContain('上报中')
  })

  test('已署名且在上报 → 报出署名、地址与间隔', () => {
    const text = describeCurrent(loaded({ flushIntervalMillis: 30_000 }), undefined)
    expect(text).toContain('当前署名：张三 · 研发一部')
    expect(text).toContain('上报中 → http://127.0.0.1:8787/api/v1/token-usage')
    expect(text).toContain('每 30 秒一批')
  })

  test('★ 保存后宿主回报的状态优先于 GET 那一刻的旧状态', () => {
    const text = describeCurrent(
      loaded({ reporting: { enabled: false, endpoint: 'http://old/api/v1/token-usage', reason: '未启用' } }),
      { enabled: true, endpoint: 'http://new/api/v1/token-usage' },
    )
    expect(text).toContain('http://new/api/v1/token-usage')
    expect(text).not.toContain('http://old/api/v1/token-usage')
  })

  test('间隔是 0（旧宿主没这个字段）→ 按默认档位说，不显示「每 0 秒」', () => {
    const text = describeCurrent(loaded({ flushIntervalMillis: 0 }), undefined)
    expect(text).toContain(`每 ${intervalLabel(UI_DEFAULT_FLUSH_INTERVAL_MILLIS)}一批`)
    expect(text).not.toContain('每 0')
  })

  test('没有分组时不拖一个空的分隔点', () => {
    const text = describeCurrent(loaded({ group: undefined }), undefined)
    expect(text).toContain('当前署名：张三。')
    expect(text).not.toContain(' · ')
  })
})

describe('间隔文案（也是下拉框里那一项的文字）', () => {
  test('整分钟用「分钟」，其余用「秒」', () => {
    expect(intervalLabel(1_000)).toBe('1 秒')
    expect(intervalLabel(5_000)).toBe('5 秒')
    expect(intervalLabel(10_000)).toBe('10 秒')
    expect(intervalLabel(60_000)).toBe('1 分钟')
    expect(intervalLabel(300_000)).toBe('5 分钟')
  })

  test('部署配置写了个非预设值（例如 7 秒）→ 也得有个读得懂的说法', () => {
    expect(intervalLabel(7_000)).toBe('7 秒')
    expect(intervalLabel(90_000)).toBe('90 秒')
  })
})