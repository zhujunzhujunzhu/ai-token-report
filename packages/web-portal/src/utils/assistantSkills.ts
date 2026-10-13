/** 助手技能选择只修改当前草稿，键盘选项不能触发普通回车发送。 */
import { ASSISTANT_SKILLS, ASSISTANT_SKILL_ACTIONS, type AssistantCustomSkill, type AssistantCustomSkillVisibility } from '@ai-token-report/shared'

/**
 * 斜杠菜单里的一项。
 *
 * ★ 三类条目合并成同一个形状给菜单渲染，但**含义不同**：
 *   `builtin` 是平台维护的默认报表技能；`custom` 是成员保存的草稿（带可见范围）；
 *   `action` 是浏览器自己处理的动作（`/create-skill` 打开表单，从不进入对话）。
 *   合成一类会让「选中 /create-skill 之后要不要发出去」只能靠命令字符串判断。
 */
export interface AssistantSkillMenuOption {
  id: string
  command: string
  title: string
  description: string
  /** 选中后填入草稿的正文；动作条目为空串（由页面打开表单）。 */
  prompt: string
  kind: 'builtin' | 'custom' | 'action'
  visibility?: AssistantCustomSkillVisibility
  mine?: boolean
  canDelete?: boolean
  skillId?: string
}

/** 内置七项 → 自定义技能（服务端已按「私有在前」排序）→ 动作条目。 */
export function assistantSkillMenuOptions(skills: readonly AssistantCustomSkill[] = []): AssistantSkillMenuOption[] {
  return [
    ...ASSISTANT_SKILLS.map(skill => ({ id: skill.id, command: skill.command, title: skill.title, description: skill.description, prompt: skill.prompt, kind: 'builtin' as const })),
    ...skills.map(skill => ({ id: skill.skill_id, command: skill.command, title: skill.title, description: skill.description, prompt: skill.prompt, kind: 'custom' as const, visibility: skill.visibility, mine: skill.mine, canDelete: skill.can_delete, skillId: skill.skill_id })),
    ...ASSISTANT_SKILL_ACTIONS.map(action => ({ id: action.command, command: action.command, title: action.title, description: action.description, prompt: '', kind: 'action' as const })),
  ]
}

/** 整段草稿仅为斜杠与搜索词时打开菜单，正文中的路径和 URL 保持普通输入。 */
export function assistantSkillQuery(prompt: string): string | null {
  const match = /^\s*\/([^\s/]*)$/.exec(prompt)
  return match ? match[1]!.toLocaleLowerCase() : null
}

export function assistantSkillOptions(prompt: string, skills: readonly AssistantSkillMenuOption[] = assistantSkillMenuOptions()): AssistantSkillMenuOption[] {
  const query = assistantSkillQuery(prompt)
  if (query === null) return []
  return skills.filter(skill => `${skill.command} ${skill.title} ${skill.description}`.toLocaleLowerCase().includes(query))
}

/** 动作条目只填命令本身：Enter 在发出去之前会被 `assistantLocalCommand()` 接住。 */
export function assistantSkillDraft(skill: AssistantSkillMenuOption): string {
  if (skill.kind === 'action') return skill.command
  return `${skill.command} ${skill.prompt}`.trimEnd()
}

/**
 * 浏览器本地处理的命令：整段草稿恰好是这条命令时，由页面自己执行（打开表单），不发给模型。
 *
 * ★ 服务端对 `/create-skill` 只会回一句「请从菜单打开表单」：拦截必须发生在发送之前，
 *   否则用户按 Enter 得到的是一个报错，而不是那个表单。
 */
export function assistantLocalCommand(prompt: string): string | null {
  const trimmed = prompt.trim()
  return ASSISTANT_SKILL_ACTIONS.some(action => action.command === trimmed) ? trimmed : null
}

/** 菜单与列表里的可见范围标记；内置技能没有标记。 */
export function assistantSkillBadge(skill: AssistantSkillMenuOption): string {
  if (skill.kind === 'action') return '打开表单'
  if (skill.kind === 'builtin') return ''
  return skill.visibility === 'public' ? '部门共享' : '仅自己'
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