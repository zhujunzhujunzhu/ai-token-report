/** 当前管理页的快捷提示仅填入问题草稿，权限和实际查询仍由现有工具校验。 */
import { ASSISTANT_FORMS, ASSISTANT_PAGES, type AssistantFormContext } from '@ai-token-report/shared'

export const assistantFormLabels: Record<AssistantFormContext['resource'], string> = {
  members: '人员资料', groups: '分组', 'provider-aliases': '供应商模型规则', 'project-aliases': '项目规则', pricing: '模型单价',
}
export interface AssistantPageAction { label: string; prompt: string }
const directoryPrompts: Record<string, AssistantPageAction> = {
  '/members': { label: '查看人员目录', prompt: '查询我有权查看的人员目录，用表格展示姓名、分组和状态。' },
  '/groups': { label: '查看分组目录', prompt: '查询分组目录，用表格展示名称和状态。' },
  '/roles': { label: '查看角色目录', prompt: '查询我有权查看的角色目录，用表格展示角色名称和权限。' },
  '/providers': { label: '查看归一化规则', prompt: '查询我有权查看的供应商和模型归一化规则，用表格展示。' },
  '/projects': { label: '查看项目规则', prompt: '查询我有权查看的项目归一化规则，用表格展示。' },
  '/pricing': { label: '查看模型单价', prompt: '查询模型单价，用表格展示模型、供应商、币种、四类单价和生效时间。' },
}
export function assistantPageActions(path: string, can: (permission: string) => boolean, currentForm?: AssistantFormContext | null): AssistantPageAction[] {
  const page = ASSISTANT_PAGES.find(item => item.path === path)
  if (!page || !can(page.permission)) return []
  const actions: AssistantPageAction[] = []
  const directory = directoryPrompts[path]
  if (directory) actions.push(directory)
  if (['/overview', '/analysis', '/records', '/diagnostics'].includes(path)) {
    actions.push({ label: '调整页面筛选', prompt: '请把当前页面的时间范围切换为最近7天，保留其他筛选条件。' })
    actions.push({ label: '重置页面筛选', prompt: '请重置当前页面的筛选条件。' })
  }
  if (!currentForm) actions.push({ label: '刷新当前页面', prompt: '请刷新当前页面的数据。' })
  const definition = ASSISTANT_FORMS.find(item => item.path === path)
  if (!definition || !can(definition.permission)) return actions
  if (currentForm?.resource === definition.resource) {
    actions.push({ label: '继续填写此表单', prompt: '请帮我继续填写当前打开的表单，只调整下面指定的字段，其他内容保持不变，填好后等我核对并点击保存。\n需要调整：' })
  } else if (!currentForm && (definition.resource !== 'members' || can('roles:assign'))) {
    actions.push({ label: `新建${assistantFormLabels[definition.resource]}表单`, prompt: `请打开新建${assistantFormLabels[definition.resource]}的表单，按以下要求预填，填好后等我核对并点击保存。\n填写要求：` })
  }
  return actions
}
