/** 新建技能表单：页面即时校验与服务端准入同规则，提交字段统一规范化。 */
import { expect, test } from 'bun:test'
import { ASSISTANT_CUSTOM_SKILL_LIMITS } from '@ai-token-report/shared'
import { assistantSkillFormError, assistantSkillInput, emptyAssistantSkillForm } from '../src/utils/assistantSkillForm.js'

const form = (overrides: Partial<ReturnType<typeof emptyAssistantSkillForm>> = {}) =>
  ({ ...emptyAssistantSkillForm(), command: '/weekly-cost', title: '上周费用', description: '按供应商看费用', prompt: '生成上周的费用分析报表', ...overrides })

test('空表单逐项提示，合法表单通过', () => {
  expect(assistantSkillFormError(emptyAssistantSkillForm())).toBe('请填写命令，例如 /weekly-cost')
  expect(assistantSkillFormError(form({ command: '' }))).toBe('请填写命令，例如 /weekly-cost')
  expect(assistantSkillFormError(form({ command: 'weekly-cost' }))).toContain('命令需要以 / 开头')
  expect(assistantSkillFormError(form({ command: '/weekly_cost' }))).toContain('命令需要以 / 开头')
  expect(assistantSkillFormError(form({ command: '/x'.repeat(20) }))).toContain(`最多 ${ASSISTANT_CUSTOM_SKILL_LIMITS.command_chars} 个字符`)
  expect(assistantSkillFormError(form({ command: '/report' }))).toContain('已被平台内置技能占用')
  expect(assistantSkillFormError(form({ command: '/create-skill' }))).toContain('已被平台内置技能占用')
  expect(assistantSkillFormError(form({ title: '' }))).toBe('请填写技能标题')
  expect(assistantSkillFormError(form({ title: 'x'.repeat(ASSISTANT_CUSTOM_SKILL_LIMITS.title_chars + 1) }))).toContain('技能标题最多')
  expect(assistantSkillFormError(form({ description: '' }))).toBe('请填写技能说明')
  expect(assistantSkillFormError(form({ description: 'x'.repeat(ASSISTANT_CUSTOM_SKILL_LIMITS.description_chars + 1) }))).toContain('技能说明最多')
  expect(assistantSkillFormError(form({ prompt: '' }))).toBe('请填写指令草稿')
  expect(assistantSkillFormError(form({ prompt: 'x'.repeat(ASSISTANT_CUSTOM_SKILL_LIMITS.prompt_chars + 1) }))).toContain('指令草稿最多')
  expect(assistantSkillFormError(form({ title: '带\t制表符' }))).toBe('技能标题与说明不能包含换行或制表符')
  expect(assistantSkillFormError(form())).toBeNull()
})

test('提交字段统一：命令小写、文本去首尾空白，可见范围原样传递', () => {
  const input = assistantSkillInput(form({ command: ' /Weekly-Cost ', title: ' 上周费用 ', description: ' 按供应商看费用 ', prompt: ' 生成上周报表\n按供应商分布 ', visibility: 'public' }))
  expect(input).toEqual({ command: '/weekly-cost', title: '上周费用', description: '按供应商看费用', prompt: '生成上周报表\n按供应商分布', visibility: 'public' })
  expect(assistantSkillFormError({ ...form(), command: input.command })).toBeNull()
})