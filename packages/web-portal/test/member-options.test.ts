/**
 * 人员下拉候选的回归：**名册 ∪ 用量派生键，再按所选分组收窄**。
 *
 * ## 这些断言在守什么
 *
 * 1. ★ 未选分组 = **全部人员**，包含当前时间窗内零用量的人。老做法只从
 *    用量行里取候选，于是刚入职 / 休假的人在下拉里根本不存在，
 *    而使用者会以为「这个人不在系统里」。
 * 2. ★ 选中分组 = 只列该分组的成员，且**多对多**（属于任一所选分组即列出）。
 * 3. ★ 名册取不到时**不做任何收窄** —— 不许凭一份空名册删掉使用者的选项。
 * 4. ★ 未署名 / 待确认历史必须仍然可选（它们是真实存在的归属状态，
 *    人员目录里表达不出来）；但它们不属于任何分组，所以筛分组时不再列出。
 */
import { describe, expect, test } from 'bun:test'
import type { BreakdownRow, StatsGroupOption, StatsMemberOption } from '@ai-token-report/shared'
import { identityLabel, memberFilterLabel, memberFilterOptions } from '../src/types/portal.js'

const GROUPS: StatsGroupOption[] = [
  { group_id: 'g-dev', name: '数字建造中心-开发', status: 'active', member_count: 2 },
  { group_id: 'g-ops', name: '运维组', status: 'active', member_count: 1 },
]

/** 名册：张三属于开发组，李四同时属于开发与运维，王五已停用且未分组。 */
const DIRECTORY: StatsMemberOption[] = [
  { member_id: '11111111-1111-4111-8111-111111111111', name: '张三', status: 'active', group_ids: ['g-dev'] },
  { member_id: '22222222-2222-4222-8222-222222222222', name: '李四', status: 'active', group_ids: ['g-dev', 'g-ops'] },
  { member_id: '33333333-3333-4333-8333-333333333333', name: '王五', status: 'disabled', group_ids: [] },
]

/** 用量行：只有张三这个窗口里用过；另有未署名与一条待确认历史。 */
const USAGE: BreakdownRow[] = [
  { key: '11111111-1111-4111-8111-111111111111', label: '张三', member_id: '11111111-1111-4111-8111-111111111111', group_names: ['数字建造中心-开发'] } as BreakdownRow,
  { key: 'legacy:5byg', label: '历史人员：旧机器（待确认）' } as BreakdownRow,
  { key: 'unknown', label: '未归属' } as BreakdownRow,
]

describe('人员候选：分组联动', () => {
  test('未选分组列出全部人员，含窗口内零用量的人', () => {
    const options = memberFilterOptions(DIRECTORY, USAGE, [], GROUPS)
    expect(options.map((option) => option.key)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      'legacy:5byg',
      'unknown',
    ])
    // 零用量的李四、王五都在，「未署名 / 待确认历史」也在。
    expect(options[0]?.label).toBe('张三 · 数字建造中心-开发 · 11111111')
    expect(options[2]?.label).toBe('王五（停用） · 33333333')
  })

  test('选中分组只列该分组成员（多对多：属于任一所选分组即列出）', () => {
    const options = memberFilterOptions(DIRECTORY, USAGE, ['g-dev'], GROUPS)
    expect(options.map((option) => option.key)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ])
    // ★ 未署名 / 待确认历史不属于任何分组：筛分组时留着它只会让人选出
    //   一个「什么都没筛出来」的条件（服务端按 AND 叠加，必然为 0）。
    expect(options.some((option) => option.key === 'unknown')).toBe(false)
    const both = memberFilterOptions(DIRECTORY, USAGE, ['g-ops'], GROUPS)
    expect(both.map((option) => option.key)).toEqual(['22222222-2222-4222-8222-222222222222'])
  })

  test('未分组的人在任何分组下都不出现，但未选分组时一定在其中', () => {
    const all = memberFilterOptions(DIRECTORY, USAGE, [], GROUPS).map((option) => option.key)
    expect(all).toContain('33333333-3333-4333-8333-333333333333')
    for (const group of ['g-dev', 'g-ops']) {
      expect(memberFilterOptions(DIRECTORY, USAGE, [group], GROUPS).map((o) => o.key))
        .not.toContain('33333333-3333-4333-8333-333333333333')
    }
  })

  test('名册取不到时不做任何收窄（旧服务端 / 请求失败）', () => {
    const options = memberFilterOptions([], USAGE, ['g-dev'], GROUPS)
    expect(options.map((option) => option.key)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      'legacy:5byg',
      'unknown',
    ])
  })

  test('目录里翻不到、却有用量的人员仍然列出（不因目录缺失而消失）', () => {
    const stranger = { key: '99999999-9999-4999-8999-999999999999', label: '外部同事', member_id: '99999999-9999-4999-8999-999999999999' } as BreakdownRow
    const options = memberFilterOptions(DIRECTORY, [...USAGE, stranger], ['g-dev'], GROUPS)
    expect(options.map((option) => option.key)).toContain(stranger.key)
  })

  test('分组名翻不到时保留「未知分组」，不把行显示成空白', () => {
    const orphan: StatsMemberOption[] = [
      { member_id: '44444444-4444-4444-8444-444444444444', name: '赵六', status: 'active', group_ids: ['g-gone'] },
    ]
    expect(memberFilterOptions(orphan, [], [], GROUPS)[0]?.label).toBe('赵六 · 未知分组 · 44444444')
  })
})

describe('人员显示名', () => {
  test('下拉与排行共用同一份拼法', () => {
    const row = { key: 'k', label: '张三', member_id: '11111111-1111-4111-8111-111111111111', group_names: ['研发一部', '平台组'] } as BreakdownRow
    expect(identityLabel(row)).toBe('张三 · 研发一部、平台组 · 11111111')
    expect(identityLabel(row)).toBe(
      memberFilterLabel('张三', row.member_id, row.group_names ?? []),
    )
  })

  test('没有稳定 ID 的归属键（未署名 / 历史）不加后缀', () => {
    expect(memberFilterLabel('未署名', null, [])).toBe('未署名')
    expect(memberFilterLabel('历史人员：旧机器（待确认）', undefined, [])).toBe(
      '历史人员：旧机器（待确认）',
    )
  })
})