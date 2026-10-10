/** 模型终止信息只公开固定分类与提示；原始思考、服务错误正文和凭证不进入浏览器或日志。 */
const REASON_KINDS = new Set(['error', 'max-tokens', 'aborted', 'blocked', 'interrupted', 'forked'])
const FAILURE_CODES: Readonly<Record<string, string>> = {
  AUTH: 'MODEL_AUTHENTICATION_FAILED', MISSING_CREDENTIAL: 'MODEL_AUTHENTICATION_FAILED', INVALID_CREDENTIAL: 'MODEL_AUTHENTICATION_FAILED',
  RATE_LIMIT: 'MODEL_RATE_LIMITED', QUOTA_EXCEEDED: 'MODEL_QUOTA_EXCEEDED',
  CONTEXT_WINDOW_EXCEEDED: 'MODEL_CONTEXT_LIMIT', INVALID_REQUEST: 'MODEL_REQUEST_REJECTED',
  TIMEOUT: 'MODEL_TIMEOUT', TRANSPORT: 'MODEL_TRANSPORT_FAILED', STREAM_CLOSED: 'MODEL_TRANSPORT_FAILED',
  EMPTY_RESPONSE: 'MODEL_EMPTY_RESPONSE', SERVER: 'MODEL_SERVICE_FAILED', ABORTED: 'MODEL_INTERRUPTED',
}

export class AssistantRuntimeError extends Error {
  readonly code: string
  readonly reasonKind: string
  readonly publicMessage: string
  constructor(reasonKind: string, failureCode?: string) {
    const safeKind = REASON_KINDS.has(reasonKind) ? reasonKind : 'unknown'
    const knownCode = failureCode !== undefined && Object.hasOwn(FAILURE_CODES, failureCode) ? FAILURE_CODES[failureCode] : undefined
    const code = safeKind === 'max-tokens' ? 'MODEL_OUTPUT_LIMIT'
      : safeKind === 'error' ? knownCode ?? 'MODEL_RUNTIME_FAILURE'
      : ['aborted', 'blocked', 'interrupted', 'forked'].includes(safeKind) ? 'MODEL_INTERRUPTED' : 'MODEL_RUNTIME_FAILURE'
    const publicMessage = code === 'MODEL_OUTPUT_LIMIT'
      ? '模型达到本轮输出预算，回答可能未完整。本轮消息已保留，请缩小范围后继续。'
      : '助手本轮未完成。本轮消息已保留，请稍后继续；如仍失败，请联系管理员检查模型服务。'
    super(publicMessage)
    this.name = 'AssistantRuntimeError'
    this.code = code; this.reasonKind = safeKind; this.publicMessage = publicMessage
  }
}
