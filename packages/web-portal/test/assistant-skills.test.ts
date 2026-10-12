/** 斜杠菜单回归：搜索真实目录，选择只写草稿，输入法与原发送快捷键互不干扰。 */
import { expect, test } from 'bun:test'
import { ASSISTANT_SKILLS } from '@ai-token-report/shared'
import { assistantSkillQuery, assistantSkillOptions, assistantSkillDraft, assistantSkillMove, assistantSkillMenuHeight, handleAssistantSkillKeydown } from '../src/utils/assistantSkills.js'
import { handleAssistantComposerKeydown } from '../src/utils/assistantComposer.js'

test('斜杠展示默认技能，支持命令与中文需求搜索', () => {
  expect(assistantSkillOptions('/').map(item => item.command)).toEqual(ASSISTANT_SKILLS.map(item => item.command))
  expect(assistantSkillOptions('/REPORT').some(item => item.command === '/report')).toBe(true)
  for (const skill of ASSISTANT_SKILLS) {
    expect(assistantSkillOptions(`/${skill.title}`).some(item => item.id === skill.id)).toBe(true)
    expect(assistantSkillDraft(skill)).toBe(`${skill.command} ${skill.prompt}`)
  }
  expect(assistantSkillOptions('/不存在的技能')).toEqual([])
})

test('带参数的命令、正文路径、URL 和多行正文不打开技能菜单', () => {
  for (const prompt of ['/report 本月按项目', '查看 /report', 'https://example.test/report', '/report\n本月', '/api/v1/stats', '普通问题']) {
    expect(assistantSkillQuery(prompt)).toBeNull()
    expect(assistantSkillOptions(prompt)).toEqual([])
  }
  expect(assistantSkillQuery('  /week')).toBe('week')
})

function press(overrides: Partial<Parameters<typeof handleAssistantSkillKeydown>[0]> = {}, menu = { open: true, count: 7 }) {
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
  expect(assistantSkillMove(0, -1, 7)).toBe(6)
  expect(assistantSkillMove(6, 1, 7)).toBe(0)
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
