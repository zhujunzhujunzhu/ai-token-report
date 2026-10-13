/**
 * 供应商 / 模型归一化页的折叠判断（纯函数，真实 `bun test`）。
 *
 * ★ 这里钉的是「一行 = 一个归一化后的名字」这件事的**全部**算术：几条规则、
 *   几个原始值（同一个原始值配了全局 + 按人员时只算一个）、哪些人、几条停用。
 *   渲染层只负责把这些数字摆出来 —— 它们算错了页面上不会报错，只会让人配错规则
 *   （以为某个原始名没折进来、或者以为某个人没配规则）。
 *
 * ★ 这一页比项目那页多一个**维度**，所以下面单独钉住两件事：
 *   ① 供应商组与模型组必须分开（同一个展示名可以在两个维度里各有一组）；
 *   ② 模型规则的「原始值」要带上限定供应商 —— 只写模型名会让
 *      「任意供应商的 `gpt-4o`」与「`azure-openai` 的 `gpt-4o`」看起来一样。
 */
import { describe, expect, test } from 'bun:test'
import { ANY_PROVIDER, type PortalProviderAlias } from '@ai-token-report/shared'
import {
  groupProviderRules, providerGroupRowKey, providerRuleKeepsSourceName, providerRuleSourceOf, providerRuleTarget,
} from '../src/views/providersModel.js'

let sequence = 0
function rule(input: Partial<PortalProviderAlias> & { provider: string }): PortalProviderAlias {
  sequence += 1
  return {
    alias_id: `alias-${String(sequence).padStart(3, '0')}`,
    scope: 'global',
    member_id: null,
    member_name: null,
    model: null,
    alias: '阿里百炼',
    enabled: true,
    created_at_ms: 1_800_000_000_000,
    updated_at_ms: 1_800_000_000_000,
    ...input,
  }
}
const person = (id: string, name: string) => ({ scope: 'member' as const, member_id: id, member_name: name })
const query = (input: Partial<{ search: string; scope: string; target: string }> = {}) => ({ search: '', scope: '', target: '', ...input })

describe('供应商归一化：规则折叠成名字行', () => {
  test('同一个展示名下的多个原始供应商名折叠成一行，原始值数与规则数分开算', () => {
    const groups = groupProviderRules([
      rule({ provider: 'dashscope' }),
      rule({ provider: 'aliyun' }),
      rule({ provider: 'bailian' }),
    ], query())
    expect(groups).toHaveLength(1)
    expect(groups[0]!.key).toBe('provider:阿里百炼')
    expect(groups[0]!.target).toBe('provider')
    expect(groups[0]!.ruleCount).toBe(3)
    expect(groups[0]!.sourceCount).toBe(3)
    expect(groups[0]!.sources).toEqual(['aliyun', 'bailian', 'dashscope'])
    expect(groups[0]!.globalRules).toBe(3)
    expect(groups[0]!.enabledRules).toBe(3)
    expect(groups[0]!.disabledRules).toBe(0)
    expect(groups[0]!.members).toEqual([])
  })

  test('同一个原始值上的全局规则与按人员规则各占一条，但原始值只算一个', () => {
    const groups = groupProviderRules([
      rule({ provider: 'dashscope' }),
      rule({ provider: 'dashscope', ...person('m-1', '张三') }),
    ], query())
    expect(groups[0]!.ruleCount).toBe(2)
    expect(groups[0]!.sourceCount).toBe(1)
    expect(groups[0]!.globalRules).toBe(1)
    expect(groups[0]!.memberRules).toBe(1)
    expect(groups[0]!.members).toEqual([{ member_id: 'm-1', name: '张三', ruleCount: 1, enabledCount: 1 }])
  })

  test('★ 供应商组与模型组分开：同一个展示名在两个维度里就是两行', () => {
    // 一条规则只折叠一个维度，所以「阿里百炼当供应商名」与「阿里百炼当模型名」
    // 在库里是两组互不相干的规则 —— 合成一行会让人以为一条规则改了两个维度。
    const groups = groupProviderRules([
      rule({ provider: 'dashscope', alias: '阿里百炼' }),
      rule({ provider: ANY_PROVIDER, model: '阿里百炼', alias: '阿里百炼' }),
    ], query())
    expect(groups.map((group) => group.key)).toEqual(['provider:阿里百炼', 'model:阿里百炼'])
    expect(groups.map((group) => group.target)).toEqual(['provider', 'model'])
  })

  test('★ 模型规则的原始值带上限定供应商，只写模型名会让两条规则看起来一样', () => {
    const groups = groupProviderRules([
      rule({ provider: ANY_PROVIDER, model: 'qwen-max', alias: '通义千问-Max' }),
      rule({ provider: 'azure-openai', model: 'qwen-max', alias: '通义千问-Max' }),
    ], query())
    expect(groups).toHaveLength(1)
    expect(groups[0]!.sourceCount).toBe(2)
    expect(groups[0]!.sources).toEqual(['azure-openai · qwen-max', '任意供应商 · qwen-max'])
  })

  test('人员汇总按成员去重并分别记账（停用的那条不计入启用数）', () => {
    const groups = groupProviderRules([
      rule({ provider: 'a', ...person('m-2', '李四') }),
      rule({ provider: 'b', ...person('m-2', '李四'), enabled: false }),
      rule({ provider: 'c', ...person('m-1', '张三') }),
      rule({ provider: 'd', enabled: false }),
    ], query())
    expect(groups[0]!.members).toEqual([
      { member_id: 'm-1', name: '张三', ruleCount: 1, enabledCount: 1 },
      { member_id: 'm-2', name: '李四', ruleCount: 2, enabledCount: 1 },
    ])
    expect(groups[0]!.enabledRules).toBe(2)
    expect(groups[0]!.disabledRules).toBe(2)
  })

  test('人员规则缺姓名时给显式占位，不出现空标签', () => {
    const groups = groupProviderRules([rule({ provider: 'a', ...person('m-9', ''), member_name: null })], query())
    expect(groups[0]!.members[0]!.name).toBe('（已删除的成员）')
  })

  test('组内顺序：全局基线在前，再按人员姓名，再按原始值字符序', () => {
    const groups = groupProviderRules([
      rule({ provider: 'b', ...person('m-2', '李四') }),
      rule({ provider: 'z' }),
      rule({ provider: 'a', ...person('m-1', '张三') }),
      rule({ provider: 'a' }),
    ], query())
    expect(groups[0]!.rules.map((entry) => `${entry.scope}:${entry.member_name ?? '-'}:${entry.provider}`)).toEqual([
      'global:-:a', 'global:-:z', 'member:张三:a', 'member:李四:b',
    ])
  })

  test('原始值去重后按字符序，更新时间取该组最大值', () => {
    const groups = groupProviderRules([
      rule({ provider: 'b', updated_at_ms: 10 }),
      rule({ provider: 'b', ...person('m-1', '张三'), updated_at_ms: 30 }),
      rule({ provider: 'a', updated_at_ms: 20 }),
    ], query())
    expect(groups[0]!.sources).toEqual(['a', 'b'])
    expect(groups[0]!.sourceCount).toBe(2)
    expect(groups[0]!.updatedAtMs).toBe(30)
  })

  test('默认顺序：供应商维度在前、模型维度在后，块内原始值多的在前', () => {
    const groups = groupProviderRules([
      rule({ provider: 'x', alias: '乙' }),
      rule({ provider: 'a', alias: '甲' }),
      rule({ provider: 'b', alias: '甲' }),
      rule({ provider: ANY_PROVIDER, model: 'm1', alias: '丙' }),
      rule({ provider: 'azure-openai', model: 'm2', alias: '丙' }),
      rule({ provider: ANY_PROVIDER, model: 'm3', alias: '丁' }),
    ], query())
    expect(groups.map((group) => group.key)).toEqual(['provider:甲', 'provider:乙', 'model:丙', 'model:丁'])
  })

  test('空输入给出空列表（没有规则时页面就得说「还没有规则」）', () => {
    expect(groupProviderRules([], query())).toEqual([])
  })
})

describe('供应商归一化：维度与原始值判断', () => {
  test('`model` 有值就是模型规则，否则是供应商规则', () => {
    expect(providerRuleTarget(rule({ provider: 'dashscope' }))).toBe('provider')
    expect(providerRuleTarget(rule({ provider: ANY_PROVIDER, model: 'qwen-max' }))).toBe('model')
  })

  test('供应商规则的原始值就是原始供应商名，模型规则拼上限定范围', () => {
    expect(providerRuleSourceOf(rule({ provider: 'dashscope' }))).toBe('dashscope')
    expect(providerRuleSourceOf(rule({ provider: ANY_PROVIDER, model: 'qwen-max' }))).toBe('任意供应商 · qwen-max')
    expect(providerRuleSourceOf(rule({ provider: 'azure-openai', model: 'gpt-4o' }))).toBe('azure-openai · gpt-4o')
  })

  test('展示名与原始值相同时被标出来（照着候选填重复的那一条要能被发现）', () => {
    expect(providerRuleKeepsSourceName(rule({ provider: 'dashscope', alias: 'dashscope' }))).toBe(true)
    expect(providerRuleKeepsSourceName(rule({ provider: 'dashscope', alias: '阿里百炼' }))).toBe(false)
    // 模型规则比的是模型名：限定供应商不同不影响这条判断。
    expect(providerRuleKeepsSourceName(rule({ provider: ANY_PROVIDER, model: 'qwen-max', alias: 'qwen-max' }))).toBe(true)
  })
})

describe('供应商归一化：列表筛选', () => {
  const fixture = [
    rule({ provider: 'dashscope', alias: '阿里百炼' }),
    rule({ provider: 'aliyun', alias: '阿里百炼' }),
    rule({ provider: ANY_PROVIDER, model: 'qwen-max', alias: '通义千问-Max' }),
    rule({ provider: 'azure-openai', model: 'gpt-4o', alias: 'GPT-4o（Azure）' }),
    rule({ provider: 'openai', model: 'gpt-4o', alias: 'GPT-4o（Azure）' }),
    rule({ provider: 'moonshot', alias: '月之暗面', ...person('m-1', '张三') }),
    rule({ provider: 'zhipu', alias: '智谱', enabled: false }),
  ]

  test('关键字命中一条规则时展示整个名字（否则看不出它和哪些原始值一组）', () => {
    const groups = groupProviderRules(fixture, query({ search: 'dashscope' }))
    expect(groups.map((group) => group.key)).toEqual(['provider:阿里百炼'])
    expect(groups[0]!.rules).toHaveLength(2)
  })

  test('关键字命中展示名、模型名、人员姓名与大小写无关', () => {
    expect(groupProviderRules(fixture, query({ search: '通义' })).map((group) => group.key)).toEqual(['model:通义千问-Max'])
    expect(groupProviderRules(fixture, query({ search: 'qwen-max' })).map((group) => group.key)).toEqual(['model:通义千问-Max'])
    expect(groupProviderRules(fixture, query({ search: '张三' })).map((group) => group.key)).toEqual(['provider:月之暗面'])
    expect(groupProviderRules(fixture, query({ search: 'AZURE-OPENAI' })).map((group) => group.key)).toEqual(['model:GPT-4o（Azure）'])
    expect(groupProviderRules(fixture, query({ search: '  ' }))).toHaveLength(5)
  })

  test('关键字没命中任何规则时列表为空', () => {
    expect(groupProviderRules(fixture, query({ search: '不存在的供应商' }))).toEqual([])
  })

  test('作用对象筛选只收窄规则本身：只看模型时供应商规则不外泄', () => {
    const groups = groupProviderRules(fixture, query({ target: 'model' }))
    expect(groups.map((group) => group.key)).toEqual(['model:GPT-4o（Azure）', 'model:通义千问-Max'])
    expect(groups.every((group) => group.rules.every((entry) => entry.model !== null))).toBe(true)
    // ⚠️ 这条是「两个条件语义不同」的落点：关键字命中的是**供应商**规则，
    //   而作用对象筛的是模型 —— 若实现里先按关键字取整组再筛作用对象，
    //   这个供应商组会带着它的规则一起漏出来。
    expect(groupProviderRules(fixture, query({ search: 'dashscope', target: 'model' }))).toEqual([])
    // 作用对象筛也**不是**按展示名筛：同一个展示名在另一个维度里照旧出现。
    expect(groupProviderRules(fixture, query({ target: 'provider' })).map((group) => group.alias))
      .toEqual(['阿里百炼', '智谱', '月之暗面'])
  })

  test('作用范围只看按人员时全局规则不外泄，停用规则仍留在组里（要能启用回来）', () => {
    const groups = groupProviderRules(fixture, query({ scope: 'member' }))
    expect(groups.map((group) => group.key)).toEqual(['provider:月之暗面'])
    expect(groups[0]!.globalRules).toBe(0)
    expect(groups[0]!.sourceCount).toBe(1)
    expect(groupProviderRules(fixture, query({ search: 'dashscope', scope: 'member' }))).toEqual([])
  })

  test('作用范围只看全局时人员规则不外泄，停用的那条也还在组里', () => {
    const groups = groupProviderRules(fixture, query({ scope: 'global' }))
    expect(groups.every((group) => group.rules.every((entry) => entry.scope === 'global'))).toBe(true)
    const zhipu = groups.find((group) => group.alias === '智谱')!
    expect(zhipu.disabledRules).toBe(1)
    expect(zhipu.enabledRules).toBe(0)
  })

  test('两个筛选可以叠加（作用对象 + 作用范围）', () => {
    expect(groupProviderRules(fixture, query({ target: 'provider', scope: 'member' })).map((group) => group.key))
      .toEqual(['provider:月之暗面'])
    expect(groupProviderRules(fixture, query({ target: 'model', scope: 'member' }))).toEqual([])
  })
})

describe('供应商归一化：行标识', () => {
  test('行标识带维度前缀，避免展示名正好是原型链上的键', () => {
    const [group] = groupProviderRules([rule({ provider: ANY_PROVIDER, model: '__proto__', alias: '__proto__' })], query())
    expect(providerGroupRowKey(group!)).toBe('model:__proto__')
    expect(providerGroupRowKey(group!)).not.toBe('__proto__')
  })

  test('行标识只由维度与展示名决定，同组的规则怎么变都不换行', () => {
    const [first] = groupProviderRules([rule({ provider: 'a' })], query())
    const [second] = groupProviderRules([rule({ provider: 'a' }), rule({ provider: 'b' })], query())
    expect(providerGroupRowKey(first!)).toBe(providerGroupRowKey(second!))
  })
})