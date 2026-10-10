/** 站内动作只携带已知筛选字段，页面复用看板状态和权限门禁。 */
import { ASSISTANT_PAGES, type AssistantEvent } from '@ai-token-report/shared'
import { resolvePeriod } from '@ai-token-report/core'
import { IdentityError, type Principal } from '../identity/types.js'
const filterKeys = new Set(['period', 'from', 'to', 'provider', 'model', 'source', 'member_id', 'group_id'])
/** 来源显示名只按全等转换，Trae 国际/国内两版不能用子串折叠。 */
const sourceCodes: Record<string, string> = { dsh: 'dsh', codex: 'codex', 'claude-code': 'claude-code', 'claude code': 'claude-code', trae: 'trae', 'trae-cn': 'trae-cn', 'trae cn': 'trae-cn', workbuddy: 'workbuddy' }
export function assistantNavigation(input: unknown, principal: Principal): Extract<AssistantEvent, { type: 'navigate' }> {
  const fail = (reason: string): never => { throw new IdentityError(400, reason) }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('导航参数需要是对象')
  const raw = input as Record<string, unknown>
  if (Object.keys(raw).some(key => !['path', 'filters', 'search'].includes(key))) return fail('导航只支持页面、筛选与搜索')
  if (typeof raw.path !== 'string' || !ASSISTANT_PAGES.some(page => page.path === raw.path)) return fail('目标页面无效')
  const page = ASSISTANT_PAGES.find(page => page.path === raw.path)!
  if (!principal.permissions.includes(page.permission)) throw new IdentityError(403, '没有目标页面访问权限')
  let filters: Record<string, string> | undefined
  const inputFilters = raw.filters
  if (inputFilters !== undefined && (!inputFilters || typeof inputFilters !== 'object' || Array.isArray(inputFilters))) return fail('筛选参数需要是对象')
  // 模型可能为可选对象补 {}；它没有条件，不能误阻止管理页导航。
  if (inputFilters !== undefined && Object.keys(inputFilters).length) {
    if (!['/overview', '/analysis', '/records', '/diagnostics'].includes(page.path)) return fail('管理页面请使用搜索词，不要传统计筛选条件')
    filters = {}
    for (const [key, value] of Object.entries(inputFilters)) {
      if (!filterKeys.has(key) || typeof value !== 'string' || value.length > 180 || /[\u0000-\u001f]/.test(value)) return fail('筛选字段或值无效')
      filters[key] = key === 'source' ? sourceCodes[value.trim().toLowerCase()] ?? value : value
    }
    if (filters.period && !resolvePeriod(filters.period)) return fail('导航时间范围无效')
    if (filters.from !== undefined || filters.to !== undefined) {
      const from = Number(filters.from), to = Number(filters.to)
      if (filters.period || !filters.from || !filters.to || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to - from > (page.path === '/records' ? 31 : 366) * 86_400_000) return fail('导航自定义时间窗无效')
    }
    for (const key of ['member_id', 'group_id']) if (filters[key] && !/^[0-9a-f-]{36}$/.test(filters[key]!)) return fail('人员或分组筛选 ID 无效')
  }
  if (raw.search !== undefined && (typeof raw.search !== 'string' || raw.search.length > 120 || /[\u0000-\u001f]/.test(raw.search))) return fail('搜索词最多 120 个字符')
  return { type: 'navigate', path: page.path, ...(filters ? { filters } : {}), ...(typeof raw.search === 'string' ? { search: raw.search } : {}) }
}
