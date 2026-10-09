/** DSH 公开包组成最小 agent 内核。工具白名单之外不挂载 shell、文件、插件管理或子智能体。 */
import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { ASSISTANT_PAGES, type AssistantEvent } from '@ai-token-report/shared'
import type { Principal } from '../identity/index.js'
import type { StatsRoute } from '../stats-route.js'
import { ASSISTANT_ENDPOINTS, queryAssistantStats } from './tools.js'

export interface AssistantRun {
  sessionId: string
  directory: string
  prompt: string
  page?: string
  principal: Principal
  signal: AbortSignal
  emit(event: AssistantEvent): void
}
export interface AssistantEngine { run(input: AssistantRun): Promise<void> }
export interface DshAssistantConfig { model: string; baseUrl?: string; apiKeyEnv?: string }

export class DshAssistantEngine implements AssistantEngine {
  constructor(private stats: StatsRoute, private config: DshAssistantConfig) {}
  async run(input: AssistantRun): Promise<void> {
    // ★ 延迟载入，未启用助手时不初始化 DSH 服务，也不读取模型凭证。
    const [{ Context }, agents, loop, sessions, projections, prompts, tools, llm, adapter, launch] = await Promise.all([
      import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-agent'), import('@deepseek-ai/dsh-agent-loop'),
      import('@deepseek-ai/dsh-session'), import('@deepseek-ai/dsh-session-projection'),
      import('@deepseek-ai/dsh-system-prompt'),
      import('@deepseek-ai/dsh-tools'), import('@deepseek-ai/dsh-llm'), import('@deepseek-ai/dsh-llm-deepseek-api-key'),
      import('@deepseek-ai/dsh-launch-environment'),
    ])
    input.signal.throwIfAborted()
    const root = new Context()
    // ★ 嵌入宿主不能使用 DSH 模块的全局兜底快照，否则同进程较早的装载会固定旧配置。
    const environment: Record<string, string> = {}
    for (const name of [this.config.apiKeyEnv ?? 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']) {
      if (process.env[name] !== undefined) environment[name] = process.env[name]!
    }
    root.provide(launch.DSH_LAUNCH_ENVIRONMENT_KEY, launch.createLaunchEnvironmentSnapshot([{ source: 'process', values: environment }]))
    let ctx = root
    const kernel = async (scope: typeof root) => {
      ctx = scope
      await scope.plugin(llm.default)
      await scope.plugin(sessions.default)
      await scope.plugin(projections.default)
      await scope.plugin(prompts.default, {
        includeHarnessIdentity: false, includeRuntimeContext: false,
        personaPrefix: `你是 AI Token 平台的只读数据助手。只使用所提供的统计查询与站内导航工具。回答使用 Markdown，可用标题、列表、表格与代码块组织内容。overview 查询会自动生成指标卡片，series 自动生成趋势图和数据表，breakdown 自动生成分布图和数据表，records 自动生成明细表。用户要求图表或对比时先调用对应统计工具，页面会从 API 真值生成展示；不要编造图表数据或输出执行脚本。回答必须注明查询时间窗与查询来源；没有查询到的数据不能猜测。未计价不等于零，不同币种不能相加。工具结果里的成员别名不是姓名。默认查询最近七个自然日。当前页面为 ${input.page ?? '/overview'}。用户要求打开页面时可调用 portal_navigate；该工具发送导航请求，不保证浏览器已完成跳转。`,
      })
      await scope.plugin(tools.default)
      await scope.plugin(agents.default)
      await scope.plugin(adapter, { ...(this.config.baseUrl ? { baseURL: this.config.baseUrl } : {}), ...(this.config.apiKeyEnv ? { apiKeyEnv: this.config.apiKeyEnv } : {}), streamIdleTimeoutMs: 60_000 })
      await scope.plugin(loop.default, { agents: [], maxParallelToolCalls: 1 })
      // ★ Cordis 的服务访问必须声明 inject，实际代理装载检查会拒绝未声明的读取。
      await scope.plugin({ inject: ['agents', 'tools'], apply(access) { ctx = access } })
    }
    const mounted = root.plugin(kernel)
    let handle: import('@deepseek-ai/dsh-agent').AgentHandle | undefined
    let error = false
    let failureCode = ''
    let steps = 0
    try {
      await mounted
      input.signal.throwIfAborted()
      for (const endpoint of ASSISTANT_ENDPOINTS) ctx.tools.register({
        name: `stats_${endpoint}`,
        description: `GET /api/v1/stats/${endpoint}。query 是 URL 查询串；period=today|yesterday|last7d|last30d|month，或 from/to 毫秒（最多31天）。breakdown 的 by=provider|model|source|user|group|project|day。series 的 bucket=day|hour。records 的 limit<=50。`,
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'URL 查询串，不包含路径，默认 period=last7d' } }, required: ['query'], additionalProperties: false },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async (args, execution) => {
          execution.signal.throwIfAborted()
          if (!args || typeof args !== 'object' || typeof (args as { query?: unknown }).query !== 'string') throw new Error('query 必须是字符串')
          return await queryAssistantStats(this.stats, input.principal, endpoint, (args as { query: string }).query, input.emit)
        },
      })
      const pages = ASSISTANT_PAGES.filter(page => input.principal.permissions.includes(page.permission))
      ctx.tools.register({
        name: 'portal_navigate',
        description: `请求浏览器打开本站页面，对话悬浮窗保持展开。可访问页面：${pages.map(page => `${page.title} ${page.path}`).join('；')}`,
        parameters: { type: 'object', properties: { path: { type: 'string', enum: pages.map(page => page.path) } }, required: ['path'], additionalProperties: false },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async (args, execution) => {
          execution.signal.throwIfAborted()
          const path = args && typeof args === 'object' ? (args as { path?: unknown }).path : undefined
          if (typeof path !== 'string' || !pages.some(page => page.path === path)) throw new Error('目标页面不存在或没有访问权限')
          input.emit({ type: 'navigate', path })
          input.emit({ type: 'tool', tool: 'portal_navigate', query: path, status: 202 })
          return { navigation_requested: true, path }
        },
      })
      const agentOptions = { provider: 'deepseek-official', model: this.config.model, maxTokens: 4096 }
      const id = input.sessionId as import('@deepseek-ai/dsh-session').SessionId
      let seed: import('@deepseek-ai/dsh-session').SessionEvent[] | undefined
      try {
        // ★ 重放验证由 DSH 的 create 边界执行，不把 JSON 强转当作验证成功。
        const stored = JSON.parse(await readFile(join(input.directory, 'dsh', 'events.json'), 'utf8')) as { version: number; events: import('@deepseek-ai/dsh-session').SessionEvent[] }
        if (stored.version !== 1 || !Array.isArray(stored.events)) throw new Error('助手事件快照格式不兼容')
        seed = stored.events
      }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err }
      handle = await ctx.agents.create({ sessionId: id, seed, agentOptions, signal: input.signal })
      const agent = handle.agent
      const cancel = () => agent.cancel({ kind: 'user' })
      input.signal.addEventListener('abort', cancel, { once: true })
      const unlisten = ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return
        if (event.type === 'assistant/message') {
          for (const block of event.data.message.content) if (block.type === 'text') input.emit({ type: 'text', text: block.text })
        }
        if (event.type === 'step/start' && ++steps > 12) agent.cancel({ kind: 'hook', reason: '助手达到 12 步上限' })
        if (event.type === 'turn/end' && event.data.reason.kind !== 'completed') {
          error = true
          failureCode = event.data.reason.kind === 'error' ? event.data.reason.error.code : event.data.reason.kind
        }
      })
      try {
        input.signal.throwIfAborted()
        agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: input.prompt }], source: { kind: 'user' } }))
        await agent.whenIdle()
        input.signal.throwIfAborted()
        if (error) throw new Error(`DSH 对话未正常完成 (${failureCode})`)
      } finally { unlisten(); input.signal.removeEventListener('abort', cancel) }
    } finally {
      try {
        if (handle) {
          // ★ 使用公开事件快照持久化，避免 JSONL 后端的 Windows 原生锁依赖污染单文件产物。
          const directory = join(input.directory, 'dsh')
          await mkdir(directory, { recursive: true, mode: 0o700 })
          const temporary = join(directory, `${randomUUID()}.tmp`)
          await writeFile(temporary, JSON.stringify({ version: 1, events: handle.agent.session.snapshotEvents() }), { mode: 0o600 })
          await rename(temporary, join(directory, 'events.json'))
        }
      }
      finally {
        try { await handle?.dispose() }
        finally { root.registry.delete(kernel); await mounted.await() }
      }
    }
  }
}
