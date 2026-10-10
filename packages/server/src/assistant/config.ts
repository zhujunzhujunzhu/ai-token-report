/** 模型配置仅由服务端环境提供；客户端不能指定端点、协议或凭证。 */
export type AssistantProtocol = 'deepseek-messages' | 'openai-completions' | 'openai-responses'
export type AssistantReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh'
export interface DshAssistantConfig { model: string; baseUrl?: string; apiKeyEnv?: string; protocol?: AssistantProtocol; supportsImages?: boolean; maxTokens?: number; reasoningEffort?: AssistantReasoningEffort }
const REASONING_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh'] as const
// ★ 只声明复核过的型号；未知供应商路由不能靠名字相似获得 Qwen 私有请求参数。
const QWEN_REASONING_MODELS = new Set(['qwen3.8-max', 'qwen3.8-max-0902', 'qwen3.8-flash', 'qwen3.8-27b', 'qwen3.8-2.4t-a95b'])
export function validateAssistantConfig(config: DshAssistantConfig): DshAssistantConfig {
  const protocol = config.protocol ?? 'deepseek-messages'
  if (!['deepseek-messages', 'openai-completions', 'openai-responses'].includes(protocol)) throw new Error('ATR_ASSISTANT_PROTOCOL 需要是 deepseek-messages、openai-completions 或 openai-responses')
  if (!config.model.trim()) throw new Error('请填写 ATR_ASSISTANT_MODEL')
  const model = config.model.trim()
  if (config.supportsImages !== undefined && typeof config.supportsImages !== 'boolean') throw new Error('模型 supportsImages 配置需要是布尔值')
  if (config.maxTokens !== undefined && (!Number.isInteger(config.maxTokens) || config.maxTokens < 1 || config.maxTokens > 131072)) throw new Error('ATR_ASSISTANT_MAX_TOKENS 需要为 1～131072 的整数')
  if (config.reasoningEffort !== undefined) {
    if (!REASONING_EFFORTS.includes(config.reasoningEffort)) throw new Error('ATR_ASSISTANT_REASONING_EFFORT 需要是 off、low、medium、high 或 xhigh')
    if (protocol !== 'openai-completions' || !QWEN_REASONING_MODELS.has(model)) throw new Error('ATR_ASSISTANT_REASONING_EFFORT 仅支持已验证的 qwen3.8 型号与 openai-completions 协议')
  }
  const apiKeyEnv = config.apiKeyEnv ?? (protocol === 'deepseek-messages' ? 'DEEPSEEK_API_KEY' : 'ATR_ASSISTANT_API_KEY')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error('模型凭证需要使用有效的环境变量名')
  let baseUrl = config.baseUrl?.trim() || undefined
  if (!baseUrl && protocol !== 'deepseek-messages') throw new Error('请填写 ATR_ASSISTANT_BASE_URL（包含接口版本路径，如 /v1）')
  if (baseUrl) {
    const url = new URL(baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('模型 baseUrl 需要是无凭据、查询参数和片段的 HTTP(S) 地址')
    url.pathname = url.pathname.replace(/\/(?:chat\/completions|responses|messages)\/?$/, '').replace(/\/$/, '')
    baseUrl = url.toString().replace(/\/$/, '')
  }
  return { model, protocol, apiKeyEnv, ...(baseUrl ? { baseUrl } : {}), ...(config.supportsImages === undefined ? {} : { supportsImages: config.supportsImages }), ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }), ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }) }
}
export function assistantConfigFromEnv(environment: Record<string, string | undefined> = process.env, requireEnabled = true): DshAssistantConfig | undefined {
  if (requireEnabled && environment.ATR_ASSISTANT_ENABLED !== '1') return undefined
  const images = environment.ATR_ASSISTANT_SUPPORTS_IMAGES
  if (images !== undefined && images !== '0' && images !== '1') throw new Error('ATR_ASSISTANT_SUPPORTS_IMAGES 需要是 0 或 1；仅确认模型支持视觉后设置 1')
  const tokens = environment.ATR_ASSISTANT_MAX_TOKENS
  if (tokens !== undefined && !/^[1-9]\d*$/.test(tokens.trim())) throw new Error('ATR_ASSISTANT_MAX_TOKENS 需要为 1～131072 的整数')
  return validateAssistantConfig({
    model: environment.ATR_ASSISTANT_MODEL ?? 'deepseek-v4-flash',
    baseUrl: environment.ATR_ASSISTANT_BASE_URL,
    apiKeyEnv: environment.ATR_ASSISTANT_API_KEY_ENV,
    protocol: environment.ATR_ASSISTANT_PROTOCOL as AssistantProtocol | undefined,
    ...(images === undefined ? {} : { supportsImages: images === '1' }),
    ...(tokens === undefined ? {} : { maxTokens: Number(tokens.trim()) }),
    ...(environment.ATR_ASSISTANT_REASONING_EFFORT === undefined ? {} : { reasoningEffort: environment.ATR_ASSISTANT_REASONING_EFFORT as AssistantReasoningEffort }),
  })
}
