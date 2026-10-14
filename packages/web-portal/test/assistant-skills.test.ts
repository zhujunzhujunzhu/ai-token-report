/** 斜杠菜单回归：内置技能 + 自定义技能 + 本地动作，选择只写草稿，输入法与原发送快捷键互不干扰。 */
import { expect, test } from 'bun:test'
import { ASSISTANT_SKILLS, ASSISTANT_SKILL_ACTIONS, type AssistantCustomSkill } from '@ai-token-report/shared'
import { assistantSkillQuery, assistantSkillOptions, assistantSkillMenuOptions, assistantSkillDraft, assistantSkillBadge, assistantLocalCommand, assistantSkillMove, assistantSkillMenuHeight, assistantActionFor, assistantSkillCreateTemplate, assistantSkillTemplateCaret, handleAssistantSkillKeydown } from '../src/utils/assistantSkills.js'
import { handleAssistantComposerKeydown } from '../src/utils/assistantComposer.js'

const customSkill = (overrides: Partial<AssistantCustomSkill> = {}): AssistantCustomSkill => ({
  skill_id: '11111111-1111-4111-8111-111111111111', command: '/weekly-cost', title: '上周费用', description: '按供应商看上周费用估算',
  prompt: '生成上周的费用分析报表，按供应商分布，导出 Excel', visibility: 'private', mine: true, can_delete: true, created_at_ms: 1, updated_at_ms: 2, ...overrides,
})

test('斜杠展示内置技能、自定义技能与两条本地动作，支持命令与中文需求搜索', () => {
  expect(assistantSkillOptions('/').map(item => item.command)).toEqual([...ASSISTANT_SKILLS.map(skill => skill.command), ...ASSISTANT_SKILL_ACTIONS.map(action => action.command)])
  expect(assistantSkillOptions('/REPORT').some(item => item.command === '/report')).toBe(true)
  for (const skill of ASSISTANT_SKILLS) {
    expect(assistantSkillOptions(`/${skill.title}`).some(item => item.id === skill.id)).toBe(true)
    expect(assistantSkillDraft(assistantSkillMenuOptions()[ASSISTANT_SKILLS.indexOf(skill)]!)).toBe(`${skill.command} ${skill.prompt}`)
  }
  expect(assistantSkillOptions('/不存在的技能')).toEqual([])
})

test('自定义技能进入菜单：命令、标题与说明都能搜到，并按可见范围与脚本带标记', () => {
  const options = assistantSkillMenuOptions([customSkill(), customSkill({ skill_id: '22222222-2222-4222-8222-222222222222', command: '/team-cost', title: '部门费用', description: '按供应商看上月费用估算', visibility: 'public', mine: false, can_delete: false, owner_name: '成员甲', script: 'return input.rows.length' })])
  const menu = assistantSkillOptions('/', options)
  expect(menu.map(item => item.command)).toEqual([...ASSISTANT_SKILLS.map(skill => skill.command), '/weekly-cost', '/team-cost', '/create-skill', '/skills'])
  expect(assistantSkillOptions('/上周费用', options).map(item => item.command)).toEqual(['/weekly-cost'])
  expect(assistantSkillOptions('/部门费用', options).map(item => item.command)).toEqual(['/team-cost'])
  expect(assistantSkillOptions('/供应商看上周', options).map(item => item.command)).toEqual(['/weekly-cost'])
  expect(assistantSkillOptions('/team', options).map(item => item.command)).toEqual(['/team-cost'])
  expect(assistantSkillOptions('/create', options).map(item => item.command)).toEqual(['/create-skill'])
  expect(assistantSkillOptions('/skills', options).map(item => item.command)).toEqual(['/skills'])
  expect(assistantSkillBadge(menu[menu.length - 2]!)).toBe('对话生成')
  expect(assistantSkillBadge(menu[menu.length - 1]!)).toBe('打开列表')
  expect(assistantSkillBadge(assistantSkillOptions('/weekly-cost', options)[0]!)).toBe('仅自己')
  expect(assistantSkillBadge(assistantSkillOptions('/team-cost', options)[0]!)).toBe('部门共享')
  expect(assistantSkillBadge(assistantSkillOptions('/report', options)[0]!)).toBe('')
  // ★ 脚本只做标记：菜单里显示「含脚本」，页面不执行任何技能代码。
  expect(assistantSkillOptions('/team-cost', options)[0]!.hasScript).toBe(true)
  expect(assistantSkillOptions('/weekly-cost', options)[0]!.hasScript).toBe(false)
  // 选中自定义技能填入它保存的草稿；动作条目只填命令本身（由页面另走本地处理）。
  expect(assistantSkillDraft(assistantSkillOptions('/weekly-cost', options)[0]!)).toBe('/weekly-cost 生成上周的费用分析报表，按供应商分布，导出 Excel')
  expect(assistantSkillDraft(assistantSkillOptions('/create-skill', options)[0]!)).toBe('/create-skill')
  expect(assistantSkillMenuOptions([customSkill()])[ASSISTANT_SKILLS.length]!.canDelete).toBe(true)
})

test('★ 两条动作命令：一条预填建技能模板，一条打开技能列表', () => {
  expect(assistantActionFor('/create-skill')?.command).toBe('/create-skill')
  expect(assistantActionFor('  /SKILLS ' as string)?.command).toBe('/skills')
  expect(assistantActionFor('/report')).toBeNull()
  // 预填模板只填输入框、不发送；用户要补的是名称与用途。
  const template = assistantSkillCreateTemplate()
  expect(template).toContain('新建一个技能')
  expect(template).toContain('名称：')
  expect(template).toContain('用途：')
  // 打开列表那条没有模板，页面据此决定「填草稿还是开弹框」。
  expect(assistantActionFor('/skills')?.prompt).toBe('')
  // 光标停在「名称：」后面，用户直接输入名字。
  expect(assistantSkillTemplateCaret(template)).toBe(template.indexOf('名称：') + '名称：'.length)
  expect(assistantSkillTemplateCaret('没有标记')).toBe('没有标记'.length)
})

test('浏览器本地命令只在整段草稿就是该命令时命中，带条件的写法交给服务端解释', () => {
  expect(assistantLocalCommand('/create-skill')).toBe('/create-skill')
  expect(assistantLocalCommand('  /skills \n')).toBe('/skills')
  for (const prompt of ['/create-skill 帮我建一个', '/report', '新建技能', '', '/create-skills']) expect(assistantLocalCommand(prompt)).toBeNull()
})

test('带参数的命令、正文路径、URL 和多行正文不打开技能菜单', () => {
  const options = assistantSkillMenuOptions([customSkill()])
  for (const prompt of ['/report 本月按项目', '查看 /report', 'https://example.test/report', '/report\n本月', '/api/v1/stats', '普通问题', '/weekly-cost 本月']) {
    expect(assistantSkillQuery(prompt)).toBeNull()
    expect(assistantSkillOptions(prompt, options)).toEqual([])
  }
  expect(assistantSkillQuery('  /week')).toBe('week')
})

function press(overrides: Partial<Parameters<typeof handleAssistantSkillKeydown>[0]> = {}, menu = { open: true, count: 8 }) {
  let selected = 0, closed = 0, sent = 0, lines = 0, prevented = false
  const moved: number[] = []
  const event = { key: 'Enter', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false, keyCode: 13, repeat: false, preventDefault: () => { prevented = true }, ...overrides }
  const handled = handleAssistantSkillKeydown(event, { ...menu, select: () => { selected++ }, close: () => { closed++ }, move: direction => { moved.push(direction) } })
  if (!handled) handleAssistantComposerKeydown(event, { send: () => { sent++ }, newline: () => { lines++ } })
  return { selected, closed, sent, lines, moved, prevented, handled }
}

test('Enter 和 Tab 选择草稿且不发送；按住回车不重复选择', () => {
  for (const key of ['Enter', 'Tab']) expect(press({ key })).toMatchObject({ selected: 1, sent: 0, prevented: true, handled: true })
  expect(press({ repeat: true })).toMatchObject({ selected: 0, sent: 0, prevented: true, handled: true })
  expect(press({}, { open: false, count: 7 })).toMatchObject({ selected: 0, sent: 1, handled: false })
})

test('方向键循环选择，Escape 关闭而不发送', () => {
  expect(press({ key: 'ArrowDown' }).moved).toEqual([1])
  expect(press({ key: 'ArrowUp' }).moved).toEqual([-1])
  expect(assistantSkillMove(0, -1, 8)).toBe(7)
  expect(assistantSkillMove(7, 1, 8)).toBe(0)
  expect(assistantSkillMove(0, 1, 0)).toBe(0)
  expect(press({ key: 'Escape' })).toMatchObject({ closed: 1, selected: 0, sent: 0, handled: true })
})

test('中文选字不选择技能或发送，Alt+Enter 仍换行，Shift+Tab 保持反向聚焦', () => {
  for (const overrides of [{ isComposing: true }, { keyCode: 229 }]) expect(press(overrides)).toMatchObject({ selected: 0, sent: 0, prevented: false, handled: false })
  expect(press({ altKey: true })).toMatchObject({ selected: 0, sent: 0, lines: 1, handled: false })
  expect(press({ key: 'Tab', shiftKey: true })).toMatchObject({ selected: 0, sent: 0, prevented: false, handled: false })
})

test('无匹配时 Escape 可关闭，回车继续原发送行为以让服务端校验命令', () => {
  expect(press({ key: 'Escape' }, { open: true, count: 0 })).toMatchObject({ closed: 1, sent: 0, handled: true })
  expect(press({}, { open: true, count: 0 })).toMatchObject({ selected: 0, sent: 1, handled: false })
})

test('缩小浮窗时菜单限制到输入框上方的可用空间，大窗口仍限制最长列表', () => {
  expect(assistantSkillMenuHeight(230, 100, 44)).toBe(70)
  expect(assistantSkillMenuHeight(600, 100, 32)).toBe(280)
  expect(assistantSkillMenuHeight(160, 100, 44)).toBe(36)
})