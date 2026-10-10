/** 配置错误在发请求前失败；密钥仅以环境引用进入 DSH。 */
import { expect, test } from 'bun:test'
import { assistantConfigFromEnv, validateAssistantConfig } from '../src/assistant/config.js'
import { assistantPiProfile } from '../src/assistant/request-profile.js'
import { AssistantRuntimeError } from '../src/assistant/runtime-error.js'
test('兼容原 DeepSeek 配置，同时支持自定义 OpenAI 协议，修正完整端点与末尾斜线', () => {
  expect(assistantConfigFromEnv({})).toBeUndefined()
  expect(validateAssistantConfig({ model: '模型' }).apiKeyEnv).toBe('DEEPSEEK_API_KEY')
  const config = assistantConfigFromEnv({ ATR_ASSISTANT_MODEL: '我的模型', ATR_ASSISTANT_PROTOCOL: 'openai-completions', ATR_ASSISTANT_BASE_URL: 'https://example.test/v1/chat/completions/' }, false)
  expect(config).toEqual({ model: '我的模型', protocol: 'openai-completions', baseUrl: 'https://example.test/v1', apiKeyEnv: 'ATR_ASSISTANT_API_KEY' })
})
test('拒绝凭据嵌入地址、外链脚本协议、空模型或无版本根地址的自定义路由', () => {
  for (const baseUrl of ['https://key@example.test/v1', 'https://example.test/?key=secret', 'javascript:alert(1)']) expect(() => validateAssistantConfig({ model: '模型', baseUrl })).toThrow()
  expect(() => validateAssistantConfig({ model: '' })).toThrow('MODEL')
  expect(() => validateAssistantConfig({ model: '模型', protocol: 'openai-responses' })).toThrow('BASE_URL')
})
test('图片能力必须由部署者显式声明，协议本身不保证模型支持图片', () => {
  expect(validateAssistantConfig({ model: '模型' }).supportsImages).toBeUndefined()
  expect(assistantConfigFromEnv({ ATR_ASSISTANT_SUPPORTS_IMAGES: '1' }, false)?.supportsImages).toBe(true)
  expect(assistantConfigFromEnv({ ATR_ASSISTANT_SUPPORTS_IMAGES: '0' }, false)?.supportsImages).toBe(false)
  for (const value of ['true', 'yes', '2', '']) expect(() => assistantConfigFromEnv({ ATR_ASSISTANT_SUPPORTS_IMAGES: value }, false)).toThrow('SUPPORTS_IMAGES')
})
test('输出预算由部署显式配置，缺省保留原语义，非法或超限值在启动前拒绝', () => {
  expect(validateAssistantConfig({ model: '模型' }).maxTokens).toBeUndefined()
  for (const maxTokens of [1, 4096, 16384, 131072]) expect(validateAssistantConfig({ model: '模型', maxTokens }).maxTokens).toBe(maxTokens)
  for (const maxTokens of [0, -1, 1.5, 131073, Infinity, NaN, '16384']) expect(() => validateAssistantConfig({ model: '模型', maxTokens: maxTokens as number })).toThrow('MAX_TOKENS')
  expect(assistantConfigFromEnv({ ATR_ASSISTANT_MAX_TOKENS: '16384' }, false)?.maxTokens).toBe(16384)
  expect(assistantConfigFromEnv({ ATR_ASSISTANT_MAX_TOKENS: ' 131072 ' }, false)?.maxTokens).toBe(131072)
  for (const value of ['', '0', '-1', '1.5', '1e4', 'Infinity', 'NaN', '131073']) expect(() => assistantConfigFromEnv({ ATR_ASSISTANT_MAX_TOKENS: value }, false)).toThrow('MAX_TOKENS')
})
test('思考档位仅支持经过验证的Qwen型号与Chat协议，不猜测其他模型的私有参数', () => {
  const config = { model: 'qwen3.8-max', protocol: 'openai-completions' as const, baseUrl: 'https://example.test/v1', maxTokens: 16384 }
  for (const reasoningEffort of ['off', 'low', 'medium', 'high', 'xhigh'] as const) expect(validateAssistantConfig({ ...config, reasoningEffort }).reasoningEffort).toBe(reasoningEffort)
  expect(assistantConfigFromEnv({ ATR_ASSISTANT_MODEL: 'qwen3.8-max', ATR_ASSISTANT_PROTOCOL: 'openai-completions', ATR_ASSISTANT_BASE_URL: config.baseUrl, ATR_ASSISTANT_MAX_TOKENS: '16384', ATR_ASSISTANT_REASONING_EFFORT: 'low' }, false)).toMatchObject({ maxTokens: 16384, reasoningEffort: 'low' })
  for (const model of ['qwen3-max', 'qwen3.8-unknown', 'qwen3.8-max-2026-09-02', 'gpt-4', 'deepseek-v4-flash']) expect(() => validateAssistantConfig({ ...config, model, reasoningEffort: 'low' })).toThrow('已验证')
  for (const protocol of ['deepseek-messages', 'openai-responses'] as const) expect(() => validateAssistantConfig({ ...config, protocol, reasoningEffort: 'low' })).toThrow('openai-completions')
  for (const value of ['none', 'minimal', 'max', 'LOW', '']) expect(() => assistantConfigFromEnv({ ATR_ASSISTANT_MODEL: config.model, ATR_ASSISTANT_PROTOCOL: config.protocol, ATR_ASSISTANT_BASE_URL: config.baseUrl, ATR_ASSISTANT_REASONING_EFFORT: value }, false)).toThrow('REASONING_EFFORT')
})
test('未配置档位不关闭供应商默认思考；显式Qwen档位声明可重放reasoning而不设置冲突的双预算', () => {
  const config = { model: 'qwen3.8-max', protocol: 'openai-completions' as const, baseUrl: 'https://example.test/v1' }
  const original = assistantPiProfile(config)
  expect(original.reasoning).toBeUndefined()
  expect(original.compat).toBeUndefined()
  expect(original.models?.[0]?.reasoningEfforts).toBe(false)
  for (const reasoningEffort of ['off', 'low', 'high'] as const) {
    const profile = assistantPiProfile({ ...config, maxTokens: 16384, reasoningEffort })
    expect(profile.reasoning).toBe(reasoningEffort)
    expect(profile.models?.[0]?.maxTokens).toBe(16384)
    expect(profile.models?.[0]?.reasoningEfforts).toMatchObject({ off: 'none', low: 'low', high: 'xhigh' })
    expect(profile.compat).toMatchObject({ thinkingFormat: 'qwen', supportsReasoningEffort: true, maxTokensField: 'max_completion_tokens', requiresReasoningContentOnAssistantMessages: true })
    expect(profile.thinkingBudgets).toBeUndefined()
    expect(profile.compat?.thinkingTokenBudgetField).toBeUndefined()
    expect(profile.retryPolicy).toEqual({ mode: 'normal', maxRetries: 0 })
  }
})
test('模型终止错误只有固定公开提示与分类，预算截断和未知错误均不泄漏原始正文', () => {
  const limit = new AssistantRuntimeError('max-tokens')
  expect(limit.code).toBe('MODEL_OUTPUT_LIMIT')
  expect(limit.reasonKind).toBe('max-tokens')
  expect(limit.publicMessage).toContain('回答可能未完整')
  expect(limit.publicMessage).toContain('消息已保留')
  for (const code of ['机密正文：sk-secret', '__proto__', 'constructor']) {
    const error = new AssistantRuntimeError('error', code)
    expect(error.code).toBe('MODEL_RUNTIME_FAILURE')
    expect(error.message).toBe(error.publicMessage)
    expect(JSON.stringify(error)).not.toContain(code)
  }
  expect(new AssistantRuntimeError('error', 'AUTH').code).toBe('MODEL_AUTHENTICATION_FAILED')
  expect(new AssistantRuntimeError('error', 'TIMEOUT').code).toBe('MODEL_TIMEOUT')
  expect(new AssistantRuntimeError('aborted').code).toBe('MODEL_INTERRUPTED')
  expect(new AssistantRuntimeError('机密终止原因').reasonKind).toBe('unknown')
})
