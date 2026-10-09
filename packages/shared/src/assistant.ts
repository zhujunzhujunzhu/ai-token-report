/** 部门助手契约：空间归属由服务端身份决定，浏览器只提交会话 ID。 */
export interface AssistantSession {
  session_id: string
  title: string
  created_at_ms: number
  updated_at_ms: number
  turn_count: number
}
export interface AssistantMessage {
  role: 'user' | 'assistant'
  text: string
  results?: AssistantResult[]
}
/** 来自已鉴权统计 API 的展示快照，不接受模型生成的脚本或图表配置。 */
export interface AssistantResult {
  result_id: string
  tool: string
  query: string
  captured_at_ms: number
  title: string
  description: string
  cards?: Array<{ label: string; value: string }>
  chart?: {
    kind: 'line' | 'bar'
    labels: string[]
    series: Array<{ key: string; label: string; values: number[] }>
  }
  table?: {
    columns: Array<{ key: string; label: string; format?: 'number' | 'percent' | 'datetime' }>
    rows: Array<Record<string, string | number | null>>
    total_rows: number
  }
  note?: string
}
export interface AssistantDetail {
  session: AssistantSession
  messages: AssistantMessage[]
}
export type AssistantEvent =
  | { type: 'session'; session: AssistantSession }
  | { type: 'text'; text: string }
  | { type: 'tool'; tool: string; query: string; status: number }
  | { type: 'result'; result: AssistantResult }
  | { type: 'navigate'; path: string }
  | { type: 'done' }
  | { type: 'error'; reason: string }
export interface AssistantStatus {
  enabled: boolean
  retains_history: boolean
  retention_days: number
}
/** 站内导航工具只接受已知后台页面；前端路由仍执行各页面的权限门禁。 */
export const ASSISTANT_PAGES = [
  { path: '/overview', title: '用量总览', permission: 'stats:read' },
  { path: '/analysis', title: '用量分析', permission: 'stats:read' },
  { path: '/records', title: '调用明细', permission: 'stats:read' },
  { path: '/diagnostics', title: '采集诊断', permission: 'stats:read' },
  { path: '/members', title: '人员管理', permission: 'members:read' },
  { path: '/appkeys', title: 'appKey 管理', permission: 'tokens:manage' },
  { path: '/roles', title: '角色管理', permission: 'roles:read' },
  { path: '/groups', title: '分组管理', permission: 'groups:manage' },
  { path: '/providers', title: '供应商模型归一化', permission: 'providers:read' },
  { path: '/projects', title: '项目归一化', permission: 'projects:read' },
  { path: '/pricing', title: '模型单价', permission: 'pricing:manage' },
] as const
