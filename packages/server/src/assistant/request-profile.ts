/** 部署模型配置转成 DSH 公开 Pi provider 声明；只在明确选择思考档位后发送 Qwen 兼容参数。 */
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { ASSISTANT_ATTACHMENT_LIMITS } from '@ai-token-report/shared'
import { validateAssistantConfig, type DshAssistantConfig } from './config.js'

export function assistantPiProfile(input: DshAssistantConfig): PiAiProviderProfile {
  const config = validateAssistantConfig(input)
  const thinking = config.reasoningEffort !== undefined
  return {
    api: config.protocol,
    baseURL: config.baseUrl,
    apiKeyEnv: config.apiKeyEnv,
    models: [{
      id: config.model,
      input: config.supportsImages ? ['text', 'image'] : ['text'],
      ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
      // ⚠️ false 是能力声明，不会关闭上游默认思考。未配置时刻意保持原有请求语义。
      reasoningEfforts: thinking ? { off: 'none', low: 'low', medium: 'medium', high: 'xhigh', xhigh: 'xhigh' } : false,
    }],
    ...(thinking ? {
      reasoning: config.reasoningEffort,
      compat: {
        // ★ Qwen 接受 system，不接受 OpenAI 推理模型默认使用的 developer 角色。
        supportsDeveloperRole: false,
        thinkingFormat: 'qwen', supportsReasoningEffort: true,
        maxTokensField: 'max_completion_tokens', requiresReasoningContentOnAssistantMessages: true,
      },
    } : {}),
    requestImagePixelBudget: ASSISTANT_ATTACHMENT_LIMITS.max_image_pixels,
    requestImageMaxBytes: ASSISTANT_ATTACHMENT_LIMITS.max_image_bytes,
    maxRequestImageBytes: 64 * 1024 * 1024,
    retryPolicy: { mode: 'normal', maxRetries: 0 },
  }
}
