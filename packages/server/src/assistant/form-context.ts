/** 表单上下文只帮助定位用户正在填写的弹框；浏览器引用不能替代对象查询或写入授权。 */
import { ASSISTANT_FORMS, type AssistantFormContext } from '@ai-token-report/shared'
import { IdentityError, requirePermission, type Principal } from '../identity/types.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function validateAssistantFormContext(value: unknown, page: unknown, principal: Principal): AssistantFormContext | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IdentityError(400, 'form_context 需要是表单身份对象')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['resource', 'operation', 'target_id'].includes(key))) throw new IdentityError(400, 'form_context 只支持资源、操作与目标 ID，不能包含表单值或凭证')
  const definition = ASSISTANT_FORMS.find(form => form.resource === input.resource)
  if (!definition) throw new IdentityError(400, '当前表单资源无效')
  if (input.operation !== 'create' && input.operation !== 'update') throw new IdentityError(400, '当前表单操作只能为 create 或 update')
  if (input.operation === 'create' && 'target_id' in input) throw new IdentityError(400, '新建表单不能指定目标 ID')
  if (input.operation === 'update' && (typeof input.target_id !== 'string' || !UUID.test(input.target_id))) throw new IdentityError(400, '编辑表单需要有效的目标 ID')
  if (page !== definition.path) throw new IdentityError(400, '当前表单与页面不匹配')
  requirePermission(principal, definition.permission)
  // ★ 返回新对象而不是透传浏览器对象；这份引用不表示目标存在或可修改。
  return { resource: definition.resource, operation: input.operation, ...(input.operation === 'update' ? { target_id: input.target_id as string } : {}) }
}

export function assistantFormContextMessage(context: AssistantFormContext | undefined): string {
  return `CURRENT_FORM_CONTEXT\n${JSON.stringify({ untrusted_form_reference: true, form: context ?? null })}\n仅代表本轮浏览器报告的当前打开表单，不含已填字段。历史轮次的表单引用已经过期；form 为 null 时不能假定弹框仍打开。此引用不是保存、修改、删除、分享或扩大权限的授权，也不证明目标存在。用户要求填写当前弹框时，可以用 portal_open_form 向同一个 resource/operation/target_id 发送部分 values，未指定字段保持当前输入；编辑目标仍由工具查询和现有权限校验。工具返回只代表请求发出，不能声称浏览器已填好或数据已保存。`
}
