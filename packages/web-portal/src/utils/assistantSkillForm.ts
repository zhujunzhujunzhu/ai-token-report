/**
 * 新建技能表单的**纯函数**校验：页面即时提示与服务端准入用的是同一份规则。
 *
 * ★ 抽出来的理由：表单校验散在组件里时，页面说的「可以保存」和服务端实际接受的
 *   内容会各自演化（超长、保留命令、大小写），而两条路都不会报错 ——
 *   只会表现成「表单能提交，保存却失败」或者反过来「明明合法却不让存」。
 */
import {
  ASSISTANT_CUSTOM_SKILL_LIMITS, assistantSkillCommandReserved, assistantSkillCommandValid,
  type AssistantCustomSkillInput, type AssistantCustomSkillVisibility,
} from '@ai-token-report/shared'

export interface AssistantSkillFormState {
  command: string
  title: string
  description: string
  prompt: string
  visibility: AssistantCustomSkillVisibility
}

export function emptyAssistantSkillForm(): AssistantSkillFormState {
  return { command: '', title: '', description: '', prompt: '', visibility: 'private' }
}

/** 返回第一条人类可读的错误；`null` 表示可以提交。 */
export function assistantSkillFormError(form: AssistantSkillFormState): string | null {
  const command = form.command.trim().toLocaleLowerCase()
  if (!command) return '请填写命令，例如 /weekly-cost'
  if (!assistantSkillCommandValid(command)) return `命令需要以 / 开头、小写字母开头，只用小写字母、数字与连字符，最多 ${ASSISTANT_CUSTOM_SKILL_LIMITS.command_chars} 个字符`
  if (assistantSkillCommandReserved(command)) return `${command} 已被平台内置技能占用，请换一个命令`
  const limits: Array<[keyof AssistantSkillFormState, number, string]> = [
    ['title', ASSISTANT_CUSTOM_SKILL_LIMITS.title_chars, '技能标题'],
    ['description', ASSISTANT_CUSTOM_SKILL_LIMITS.description_chars, '技能说明'],
    ['prompt', ASSISTANT_CUSTOM_SKILL_LIMITS.prompt_chars, '指令草稿'],
  ]
  for (const [key, limit, label] of limits) {
    const value = form[key].trim()
    if (!value) return `请填写${label}`
    if (value.length > limit) return `${label}最多 ${limit} 个字符`
  }
  if (/[\r\n\t]/.test(form.title) || /[\r\n\t]/.test(form.description)) return '技能标题与说明不能包含换行或制表符'
  return null
}

/** 提交给服务端的字段：命令统一小写、文本去首尾空白，与存储层的规范化一致。 */
export function assistantSkillInput(form: AssistantSkillFormState): AssistantCustomSkillInput {
  return {
    command: form.command.trim().toLocaleLowerCase(),
    title: form.title.trim(),
    description: form.description.trim(),
    prompt: form.prompt.trim(),
    visibility: form.visibility,
  }
}