/** 技能命令只选择默认指引，不改变时间意图或操作授权。 */
import { expect, test } from 'bun:test'
import { ASSISTANT_SKILLS } from '@ai-token-report/shared'
import { resolveAssistantSkill } from '../src/assistant/skills.js'
import { assistantWriteIntent, assistantShareIntent } from '../src/assistant/intents.js'

test('每个默认技能可直接引用，空条件使用该技能请求', () => {
  for (const skill of ASSISTANT_SKILLS) {
    const resolved = resolveAssistantSkill(skill.command)
    expect(resolved.skill?.id).toBe(skill.id)
    expect(resolved.request).toBe(skill.prompt)
    expect(assistantWriteIntent(resolved.request)).toBe(false)
    expect(assistantShareIntent(resolved.request)).toBe(false)
  }
})

test('显式时间、人员、维度和格式保持用户原文，不被默认覆盖', () => {
  const request = '生成2026年9月朱俊的报表，按项目和模型，导出 Excel'
  expect(resolveAssistantSkill(`  /REPORT ${request} `)).toEqual({ skill: ASSISTANT_SKILLS[0], request })
})

test('自然语言和正文路径保持普通提问，未知技能明确失败', () => {
  expect(resolveAssistantSkill('帮我出一份周报')).toEqual({ request: '帮我出一份周报' })
  expect(resolveAssistantSkill('查看 /api/v1/stats/overview')).toEqual({ request: '查看 /api/v1/stats/overview' })
  expect(resolveAssistantSkill('/api/v1/stats/overview 是什么')).toEqual({ request: '/api/v1/stats/overview 是什么' })
  expect(() => resolveAssistantSkill('/unknown')).toThrow('这个技能不存在')
})

test('技能前缀不隐藏本轮显式分享或写入，也不把正文否定改为授权', () => {
  expect(assistantShareIntent(resolveAssistantSkill('/report 分享生成的 HTML 报告').request)).toBe(true)
  expect(assistantWriteIntent(resolveAssistantSkill('/report 修改项目规则名称').request)).toBe(true)
  expect(assistantShareIntent(resolveAssistantSkill('/report 生成报告，不要分享').request)).toBe(false)
  expect(assistantWriteIntent(resolveAssistantSkill('/report 查询项目规则，不要修改').request)).toBe(false)
})
