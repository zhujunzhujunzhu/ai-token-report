/** 部门助手契约：空间归属由服务端身份决定，浏览器只提交会话 ID。 */
export interface AssistantSession {
  session_id: string
  title: string
  created_at_ms: number
  updated_at_ms: number
  turn_count: number
}
/** 会话列表每次读取 50 条，浏览器滚动到末尾后再取下一页。 */
export const ASSISTANT_SESSION_PAGE_SIZE = 50
export interface AssistantSessionPage {
  sessions: AssistantSession[]
  next_cursor: string | null
  total: number
}
export interface AssistantMessage {
  role: 'user' | 'assistant'
  text: string
  /** 引导消息属于正在运行的轮次，重放历史时保留它与普通提问的区别。 */
  delivery?: 'steer'
  attachments?: AssistantAttachment[]
  results?: AssistantResult[]
  actions?: AssistantPendingAction[]
  artifacts?: AssistantArtifact[]
}
/** 上传元数据不暴露磁盘路径或解析正文；原文件沿用会话鉴权入口下载。 */
export interface AssistantAttachment {
  attachment_id: string
  file_name: string
  media_type: string
  size_bytes: number
  kind: 'image' | 'document' | 'text'
  extracted_chars?: number
  note?: string
}
/** 浏览器预检与服务端校验共用上限，服务端仍以实际文件内容为准。 */
export const ASSISTANT_ATTACHMENT_LIMITS = {
  max_files: 6,
  max_file_bytes: 10 * 1024 * 1024,
  max_total_bytes: 20 * 1024 * 1024,
  max_text_chars: 60_000,
  max_image_bytes: 5 * 1024 * 1024,
  max_image_dimension: 4096,
  max_image_pixels: 4_194_304,
} as const
export const ASSISTANT_ATTACHMENT_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.docx,.xlsx,.pptx,.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.log,.xml,.yaml,.yml,.html,.htm,.css,.js,.jsx,.ts,.tsx,.py,.java,.c,.cpp,.h,.cs,.go,.rs,.sh,.sql,.ini,.conf,.toml,.env'
/** 删除和停用由服务端保存待确认请求，模型不能替用户点击确认。 */
export interface AssistantPendingAction {
  action_id: string
  session_id: string
  title: string
  description: string
  resource: string
  operation: string
  target_label: string
  expires_at_ms: number
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'failed'
}
export interface AssistantArtifactShare { url: string; expires_at_ms: number }
/** 导出链接固定指向站内鉴权入口；HTML 分享由用户主动创建。 */
export interface AssistantArtifact {
  artifact_id: string
  session_id: string
  title: string
  format: 'docx' | 'xlsx' | 'html' | 'md' | 'csv' | 'txt'
  file_name: string
  size_bytes: number
  created_at_ms: number
  download_path: string
  note?: string
  share?: AssistantArtifactShare
}
/** 来自已鉴权统计 API 的展示快照，不接受模型生成的脚本或图表配置。 */
export interface AssistantResult {
  result_id: string
  tool: string
  query: string
  captured_at_ms: number
  title: string
  description: string
  /** 同一份查询可被多种方式展示；数据集 ID 只在当前用户会话内有效。 */
  dataset_id?: string
  display?: 'table' | 'echarts' | 'cards'
  echarts?: AssistantChartSpec
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
/** Agent 选择类型与字段映射，不得传任意脚本、外链或替换原始数值。 */
export interface AssistantChartSpec {
  kind: 'line' | 'bar' | 'pie' | 'scatter'
  x_key: string
  y_keys: string[]
  horizontal?: boolean
  area?: boolean
}
export interface AssistantRenderRequest {
  dataset_id: string
  title?: string
  columns?: string[]
  chart?: AssistantChartSpec
  cards?: string[]
}
export interface AssistantDetail {
  session: AssistantSession
  messages: AssistantMessage[]
}
/** 表单只预填允许的业务字段，路径由资源目录决定；实际保存仍走各管理页面的接口。 */
export const ASSISTANT_FORMS = [
  { resource: 'members', path: '/members', permission: 'members:manage', fields: ['name', 'group_ids'] },
  { resource: 'groups', path: '/groups', permission: 'groups:manage', fields: ['name'] },
  { resource: 'provider-aliases', path: '/providers', permission: 'providers:manage', fields: ['scope', 'member_id', 'provider', 'model', 'alias'] },
  { resource: 'project-aliases', path: '/projects', permission: 'projects:manage', fields: ['scope', 'member_id', 'prefix', 'alias'] },
  { resource: 'pricing', path: '/pricing', permission: 'pricing:manage', fields: ['provider', 'model', 'currency', 'input_micro_per_ktok', 'output_micro_per_ktok', 'cache_read_micro_per_ktok', 'cache_write_micro_per_ktok', 'offpeak_schedule', 'offpeak_input_micro_per_ktok', 'offpeak_output_micro_per_ktok', 'offpeak_cache_read_micro_per_ktok', 'offpeak_cache_write_micro_per_ktok', 'effective_from_ms', 'effective_to_ms', 'note'] },
] as const
export type AssistantFormResource = typeof ASSISTANT_FORMS[number]['resource']
export type AssistantFormValues = Record<string, string | number | boolean | null | string[]>
export interface AssistantFormRequest {
  resource: AssistantFormResource
  operation: 'create' | 'update'
  target_id?: string
  values?: AssistantFormValues
}
export interface AssistantForm extends AssistantFormRequest {
  request_id: string
  path: string
  values: AssistantFormValues
}
export type AssistantEvent =
  | { type: 'session'; session: AssistantSession; run_id?: string }
  | { type: 'steering'; text: string }
  | { type: 'attachments'; attachments: AssistantAttachment[] }
  | { type: 'text'; text: string }
  | AssistantToolEvent
  | { type: 'result'; result: AssistantResult }
  | { type: 'action'; action: AssistantPendingAction }
  | { type: 'artifact'; artifact: AssistantArtifact }
  | { type: 'navigate'; path: string; filters?: Record<string, string>; search?: string }
  | { type: 'open_form'; form: AssistantForm }
  | { type: 'done' }
  | { type: 'error'; reason: string }
/** 一次工具调用的开始与结束共用 ID；旧历史事件没有 state/id 时按已完成处理。 */
export interface AssistantToolEvent {
  type: 'tool'
  tool: string
  query: string
  status: number
  call_id?: string
  state?: 'running' | 'completed' | 'failed'
}
export interface AssistantStatus {
  enabled: boolean
  supports_steering?: boolean
  /** 必须由部署配置声明模型具备视觉能力，不能仅由协议推测。 */
  supports_images?: boolean
  retains_history: boolean
  /** null 表示永久保存，仅手动删除时移除。 */
  retention_days: number | null
}
/** 本轮 ID 防止网络延迟把旧引导提交给同会话的下一轮。 */
export interface AssistantSteerRequest { session_id: string; run_id: string; prompt: string }
export interface AssistantSteerResponse { ok: true; session_id: string; run_id: string }
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
