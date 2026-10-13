/**
 * 项目归一化页的折叠判断（纯函数，真实 `bun test`）。
 *
 * ★ 这里钉的是「一行 = 一个归一化后的项目」这件事的**全部**算术：几条规则、
 *   几条路径（同一路径配了全局 + 按人员时只算一条）、哪些人、几条停用。
 *   渲染层只负责把这些数字摆出来 —— 它们算错了页面上不会报错，只会让人
 *   配错规则（以为某条路径没折进来、或者以为某个人没配规则）。
 */
import { describe, expect, test } from 'bun:test'
import type { PortalProjectAlias } from '@ai-token-report/shared'
import { groupProjectRules, projectGroupRowKey } from '../src/views/projectsModel.js'

let sequence = 0
function rule(input: Partial<PortalProjectAlias> & { prefix: string }): PortalProjectAlias {
  sequence += 1
  return {
    alias_id: `alias-${String(sequence).padStart(3, '0')}`,
    scope: 'global',
    member_id: null,
    member_name: null,
    alias: '申迪项目',
    enabled: true,
    created_at_ms: 1_800_000_000_000,
    updated_at_ms: 1_800_000_000_000,
    ...input,
  }
}
const person = (id: string, name: string) => ({ scope: 'member' as const, member_id: id, member_name: name })
const query = (input: Partial<{ search: string; scope: string }> = {}) => ({ search: '', scope: '', ...input })

describe('项目归一化：规则折叠成项目行', () => {
  test('同一项目名的多条路径折叠成一行，路径数与规则数分开算', () => {
    // 线上实测形态：同一个仓库换盘 / 换父目录 / 换盘符大小写各配一条
    // （`D:\Coding_agent\suit-project-shendi-invest-page` 的四种变体 +
    //   `suit-project-shendi-page` 的两种变体）。
    const groups = groupProjectRules([
      rule({ prefix: 'D:\\Coding_agent\\suit-project-shendi-invest-page' }),
      rule({ prefix: 'd:\\Coding_agent\\suit-project-shendi-invest-page' }),
      rule({ prefix: 'D:\\Coding\\suit-project-shendi-invest-page' }),
      rule({ prefix: 'd:\\Coding\\suit-project-shendi-invest-page' }),
      rule({ prefix: 'D:\\Coding_agent\\suit-project-shendi-page' }),
      rule({ prefix: 'd:\\Coding_agent\\suit-project-shendi-page' }),
    ], query())
    expect(groups).toHaveLength(1)
    expect(groups[0]!.alias).toBe('申迪项目')
    expect(groups[0]!.ruleCount).toBe(6)
    expect(groups[0]!.pathCount).toBe(6)
    expect(groups[0]!.globalRules).toBe(6)
    expect(groups[0]!.enabledRules).toBe(6)
    expect(groups[0]!.disabledRules).toBe(0)
    expect(groups[0]!.members).toEqual([])
  })

  test('项目名逐字分组：多个空格就是另一个项目（看板本来就会分成两行）', () => {
    const groups = groupProjectRules([
      rule({ prefix: 'a', alias: '申迪项目' }),
      rule({ prefix: 'b', alias: '申迪项目 ' }),
      rule({ prefix: 'c', alias: '申迪項目' }),
    ], query())
    // 三组路径数都是 1，默认再按项目名的**码位**排（`項` U+9805 在 `项` U+9879 之前）。
    expect(groups.map((group) => group.alias)).toEqual(['申迪項目', '申迪项目', '申迪项目 '])
  })

  test('同一条路径上的全局规则与按人员规则各占一条，但路径只算一条', () => {
    const groups = groupProjectRules([
      rule({ prefix: 'D:\\Coding\\proj' }),
      rule({ prefix: 'D:\\Coding\\proj', ...person('m-1', '张三') }),
    ], query())
    expect(groups[0]!.ruleCount).toBe(2)
    expect(groups[0]!.pathCount).toBe(1)
    expect(groups[0]!.globalRules).toBe(1)
    expect(groups[0]!.memberRules).toBe(1)
    expect(groups[0]!.members).toEqual([{ member_id: 'm-1', name: '张三', ruleCount: 1, enabledCount: 1 }])
  })

  test('人员汇总按成员去重并分别记账（停用的那条不计入启用数）', () => {
    const groups = groupProjectRules([
      rule({ prefix: 'a', ...person('m-2', '李四') }),
      rule({ prefix: 'b', ...person('m-2', '李四'), enabled: false }),
      rule({ prefix: 'c', ...person('m-1', '张三') }),
      rule({ prefix: 'd', enabled: false }),
    ], query())
    expect(groups[0]!.members).toEqual([
      { member_id: 'm-1', name: '张三', ruleCount: 1, enabledCount: 1 },
      { member_id: 'm-2', name: '李四', ruleCount: 2, enabledCount: 1 },
    ])
    expect(groups[0]!.enabledRules).toBe(2)
    expect(groups[0]!.disabledRules).toBe(2)
  })

  test('人员规则缺姓名时给显式占位，不出现空标签', () => {
    const groups = groupProjectRules([rule({ prefix: 'a', ...person('m-9', '') , member_name: null })], query())
    expect(groups[0]!.members[0]!.name).toBe('（已删除的成员）')
  })

  test('组内顺序：全局基线在前，再按人员姓名，再按前缀字符序', () => {
    const groups = groupProjectRules([
      rule({ prefix: 'b', ...person('m-2', '李四') }),
      rule({ prefix: 'z' }),
      rule({ prefix: 'a', ...person('m-1', '张三') }),
      rule({ prefix: 'a' }),
    ], query())
    expect(groups[0]!.rules.map((entry) => `${entry.scope}:${entry.member_name ?? '-'}:${entry.prefix}`)).toEqual([
      'global:-:a', 'global:-:z', 'member:张三:a', 'member:李四:b',
    ])
  })

  test('路径去重后按字符序，更新时间取该组最大值', () => {
    const groups = groupProjectRules([
      rule({ prefix: 'b', updated_at_ms: 10 }),
      rule({ prefix: 'b', ...person('m-1', '张三'), updated_at_ms: 30 }),
      rule({ prefix: 'a', updated_at_ms: 20 }),
    ], query())
    expect(groups[0]!.prefixes).toEqual(['a', 'b'])
    expect(groups[0]!.pathCount).toBe(2)
    expect(groups[0]!.updatedAtMs).toBe(30)
  })

  test('默认把关联路径最多的项目排在前面，其次按项目名', () => {
    const groups = groupProjectRules([
      rule({ prefix: 'a1', alias: '乙项目' }),
      rule({ prefix: 'b1', alias: '甲项目' }),
      rule({ prefix: 'b2', alias: '甲项目' }),
    ], query())
    expect(groups.map((group) => group.alias)).toEqual(['甲项目', '乙项目'])
  })

  test('空输入给出空列表（没有规则时页面就得说「还没有规则」）', () => {
    expect(groupProjectRules([], query())).toEqual([])
  })
})

describe('项目归一化：列表筛选', () => {
  const fixture = [
    rule({ prefix: 'D:\\Coding_agent\\suit-project-shendi-page', alias: '申迪项目' }),
    rule({ prefix: 'd:\\Coding_agent\\suit-project-shendi-page', alias: '申迪项目' }),
    rule({ prefix: 'D:\\Coding\\rail-doc-review-agent', alias: '黑松轨交文档审查智能体' }),
    rule({ prefix: 'D:\\Coding\\presales-kb-parent', alias: '售前知识库', ...person('m-1', '张三') }),
    rule({ prefix: 'D:\\Coding\\presales-kb-parent\\sub', alias: '售前知识库', ...person('m-2', '李四') }),
    rule({ prefix: 'D:\\Coding\\other', alias: '别的项目', enabled: false }),
  ]

  test('关键字命中一条规则时展示整个项目（否则看不出它和哪些路径一组）', () => {
    const groups = groupProjectRules(fixture, query({ search: 'suit-project-shendi-page' }))
    expect(groups).toHaveLength(1)
    expect(groups[0]!.rules).toHaveLength(2)
  })

  test('关键字命中项目名、人员姓名与大小写无关', () => {
    expect(groupProjectRules(fixture, query({ search: '售前' })).map((group) => group.alias)).toEqual(['售前知识库'])
    expect(groupProjectRules(fixture, query({ search: '张三' })).map((group) => group.alias)).toEqual(['售前知识库'])
    expect(groupProjectRules(fixture, query({ search: 'd:\\coding_agent' })).map((group) => group.alias)).toEqual(['申迪项目'])
    expect(groupProjectRules(fixture, query({ search: '  ' }))).toHaveLength(4)
  })

  test('关键字没命中任何规则时列表为空', () => {
    expect(groupProjectRules(fixture, query({ search: '不存在的项目' }))).toEqual([])
  })

  test('作用范围筛选只收窄规则本身：按人员时全局规则不外泄', () => {
    const groups = groupProjectRules(fixture, query({ scope: 'member' }))
    expect(groups.map((group) => group.alias)).toEqual(['售前知识库'])
    expect(groups[0]!.rules.every((entry) => entry.scope === 'member')).toBe(true)
    expect(groups[0]!.globalRules).toBe(0)
    expect(groups[0]!.pathCount).toBe(2)
    // ⚠️ 这条是「两个条件语义不同」的落点：关键字命中的是**全局**规则，
    //   而作用范围筛的是按人员 —— 若实现里先按关键字取整组再筛作用范围，
    //   这个项目会带着它的全局规则一起漏出来。
    expect(groupProjectRules(fixture, query({ search: 'suit-project-shendi-page', scope: 'member' }))).toEqual([])
  })

  test('作用范围只看全局时人员规则不外泄，停用规则仍留在组里（要能启用回来）', () => {
    const groups = groupProjectRules(fixture, query({ scope: 'global' }))
    expect(groups.map((group) => group.alias)).toEqual(['申迪项目', '别的项目', '黑松轨交文档审查智能体'])
    expect(groups.find((group) => group.alias === '别的项目')!.disabledRules).toBe(1)
    expect(groups.find((group) => group.alias === '别的项目')!.enabledRules).toBe(0)
  })
})

describe('项目归一化：行标识', () => {
  test('行标识带前缀，避免项目名正好是原型链上的键', () => {
    const [group] = groupProjectRules([rule({ prefix: 'a', alias: '__proto__' })], query())
    expect(projectGroupRowKey(group!)).toBe('project:__proto__')
    expect(projectGroupRowKey(group!)).not.toBe('__proto__')
  })

  test('行标识只由项目名决定，同一项目的规则怎么变都不换行', () => {
    const [first] = groupProjectRules([rule({ prefix: 'a' })], query())
    const [second] = groupProjectRules([rule({ prefix: 'a' }), rule({ prefix: 'b' })], query())
    expect(projectGroupRowKey(first!)).toBe(projectGroupRowKey(second!))
  })
})