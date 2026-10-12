/** 助手技能选择只修改当前草稿，键盘选项不能触发普通回车发送。 */
import { ASSISTANT_SKILLS } from '@ai-token-report/shared'

export type AssistantSkillOption = typeof ASSISTANT_SKILLS[number]

/** 整段草稿仅为斜杠与搜索词时打开菜单，正文中的路径和 URL 保持普通输入。 */
export function assistantSkillQuery(prompt: string): string | null {
  const match = /^\s*\/([^\s/]*)$/.exec(prompt)
  return match ? match[1]!.toLocaleLowerCase() : null
}

export function assistantSkillOptions(prompt: string, skills: readonly AssistantSkillOption[] = ASSISTANT_SKILLS): AssistantSkillOption[] {
  const query = assistantSkillQuery(prompt)
  if (query === null) return []
  return skills.filter(skill => `${skill.command} ${skill.title} ${skill.description}`.toLocaleLowerCase().includes(query))
}

export function assistantSkillDraft(skill: AssistantSkillOption): string {
  return `${skill.command} ${skill.prompt}`.trimEnd()
}

export function assistantSkillMove(index: number, direction: -1 | 1, count: number): number {
  return count > 0 ? (index + direction + count) % count : 0
}

/** 浮窗可被用户缩小，菜单必须以实际可用高度为准，列表内部仍允许滚动。 */
export function assistantSkillMenuHeight(composerTop: number, pageTop: number, headingHeight: number): number {
  return Math.max(36, Math.min(280, composerTop - pageTop - headingHeight - 16))
}

/** 输入法确认、带修饰键换行与反向 Tab 继续交给原输入框行为。 */
export function handleAssistantSkillKeydown(
  event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'isComposing' | 'keyCode' | 'repeat' | 'preventDefault'>,
  actions: { open: boolean; count: number; move: (direction: -1 | 1) => void; select: () => void; close: () => void },
): boolean {
  if (!actions.open || event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
  if (event.key === 'Escape') { event.preventDefault(); actions.close(); return true }
  if (!actions.count) return false
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); actions.move(event.key === 'ArrowDown' ? 1 : -1); return true
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault()
    if (!event.repeat) actions.select()
    return true
  }
  return false
}
