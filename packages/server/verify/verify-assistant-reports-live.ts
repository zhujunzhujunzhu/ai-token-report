/** 默认报表技能的真实模型验收：仅把隔离合成用量交给模型，固定窗口对照真实 HTTP 与 SQL。 */
import { mkdtempSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { isDeepStrictEqual } from 'node:util'
import { preparePortalDatabase } from '@ai-token-report/core/db'
import type { AssistantArtifact, AssistantDetail, AssistantEvent, AssistantResult } from '@ai-token-report/shared'
import { IdentityRepository } from '../src/identity/index.js'
import { assistantConfigFromEnv, type DshAssistantConfig } from '../src/assistant/config.js'
import { AssistantStore } from '../src/assistant/store.js'
import { AssistantDatasets } from '../src/assistant/datasets.js'
import { presentAssistantResult } from '../src/assistant/presentation.js'
import { createServer, type ServerHandle } from '../src/index.js'

class VerificationFailure extends Error {
  constructor(readonly check: string) { super(check) }
}
function check(condition: unknown, name: string): asserts condition {
  if (!condition) throw new VerificationFailure(name)
}
const log = console.log.bind(console)
const args = process.argv.slice(2)
if (args.some(arg => arg !== '--check')) { log('REPORTS_LIVE_INVALID_ARGS: 仅支持 --check；未调用模型。'); process.exit(2) }
const checking = args.includes('--check')
const missing = ['ATR_ASSISTANT_MODEL', 'ATR_ASSISTANT_BASE_URL'].filter(name => !process.env[name]?.trim())
const keyName = process.env.ATR_ASSISTANT_API_KEY_ENV || (!process.env.ATR_ASSISTANT_PROTOCOL || process.env.ATR_ASSISTANT_PROTOCOL === 'deepseek-messages' ? 'DEEPSEEK_API_KEY' : 'ATR_ASSISTANT_API_KEY')
if (!process.env[keyName]?.trim()) missing.push(keyName)
if (missing.length) {
  log('REPORTS_LIVE_PENDING: 请填写 .env 中的 ' + missing.join('、') + '；未调用模型。')
  process.exit(checking ? 0 : 2)
}
let config: DshAssistantConfig
try { config = assistantConfigFromEnv(process.env, false)! }
catch { log('REPORTS_LIVE_CONFIG_INVALID: 请检查协议、模型、端点和凭证变量名；未调用模型。'); process.exit(2) }
if (process.env.ATR_ASSISTANT_VERIFICATION_SOURCE === 'loopback') {
  log('REPORTS_LIVE_PENDING: 当前配置标记为回环模型夹具，不能作为真实模型验收；未调用模型。')
  process.exit(checking ? 0 : 2)
}

const scenarios = [
  { id: 'monthly-project-source', prompt: '/monthly 生成2026年9月管理月报，按项目和来源，导出 Excel。', dimensions: ['project', 'source'], format: 'xlsx', title: '管理月报' },
  { id: 'cost-model-provider', prompt: '生成2026年9月的费用分析报表，按模型和供应商，导出 HTML，不要公开。', dimensions: ['model', 'provider'], format: 'html', title: '费用分析' },
] as const
if (checking) {
  log('REPORTS_LIVE_CONFIG_READY: 配置齐全，协议=' + config.protocol + '；2 个中文场景，每个 120 秒，仅单次执行，不自动重跑；未调用模型。')
  process.exit(0)
}

// ★ 构造服务端前移除业务连接与管理员配置；助手只保留上面已校验的模型配置。
for (const name of ['ATR_MYSQL_URL', 'ATR_ADMIN_TOKEN', 'ATR_ADMIN_NAME', 'ATR_ADMIN_USERNAME', 'ATR_ADMIN_PASSWORD', 'ATR_CAPTCHA_HMAC_KEY', 'ATR_PORTAL_ORIGIN']) delete process.env[name]
process.env.TZ = 'Asia/Shanghai'
const from = new Date('2026-09-01T00:00:00+08:00').getTime(), to = new Date('2026-09-30T23:59:59.999+08:00').getTime()
const root = mkdtempSync(join(tmpdir(), 'atr-assistant-reports-live-'))
const dbPath = join(root, 'portal.sqlite'), token = randomUUID()
const outputDirectory = resolve('.artifacts/assistant-reports-live')
const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
const results: Array<Record<string, unknown>> = []
let server: ServerHandle | undefined
let phase = 'fixture-setup'
let requestCount = 0
const runtimeConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }
// SDK 诊断可能包含请求或凭证，实跑阶段只输出脚本收集的固定检查名和合成数据摘要。
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) console[level] = () => {}

function decodeXml(value: string): string {
  return value.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}
function unzip(bytes: Buffer): Record<string, string> {
  const entries: Record<string, string> = {}; let offset = 0
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    check(bytes.readUInt16LE(offset + 8) === 8, 'xlsx-compression')
    const compressedSize = bytes.readUInt32LE(offset + 18), size = bytes.readUInt32LE(offset + 22)
    const nameSize = bytes.readUInt16LE(offset + 26), extraSize = bytes.readUInt16LE(offset + 28)
    const start = offset + 30 + nameSize + extraSize
    check(start + compressedSize <= bytes.length, 'xlsx-entry-bounds')
    const content = inflateRawSync(bytes.subarray(start, start + compressedSize))
    check(content.length === size, 'xlsx-entry-length')
    entries[bytes.subarray(offset + 30, offset + 30 + nameSize).toString()] = content.toString()
    offset = start + compressedSize
  }
  check(offset + 4 <= bytes.length && bytes.readUInt32LE(offset) === 0x02014b50, 'xlsx-central-directory')
  return entries
}
function sheetRows(xml: string): Array<Array<string | number | null>> {
  return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(row =>
    [...row[1]!.matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)].map(cell => {
      const numeric = /<v>([\s\S]*?)<\/v>/.exec(cell[0])
      if (numeric) return Number(numeric[1])
      const text = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(cell[0])
      return text ? decodeXml(text[1]!) : null
    }),
  )
}
async function json<T>(path: string): Promise<T> {
  const response = await fetch(server!.url + path, { headers, signal: AbortSignal.timeout(20_000) })
  check(response.status === 200, 'authorized-json-http')
  return await response.json() as T
}

try {
  check(new Date(2026, 8, 1).getTime() === from, 'fixture-beijing-timezone')
  await mkdir(outputDirectory, { recursive: true })
  await preparePortalDatabase({ sqlitePath: dbPath })
  const identity = new IdentityRepository({ sqlitePath: dbPath })
  await identity.importCredentials([{ name: '报表隔离验收管理员', token, role: 'admin' }], 'assistant-reports-live-fixture')
  const principal = (await identity.resolveBearer(token))!
  server = await createServer({ host: '127.0.0.1', port: 0, dshHomes: [root], dataDir: root, dbPath, assistant: config, requestLog: false, rollupSyncMs: 0 })
  const records = [
    { seq: 0, ts: new Date('2026-09-05T12:00:00+08:00').getTime(), input_tokens: 125, provider: '合成供应商甲', model: '合成模型甲', source: 'codex', cwd: 'D:\\Synthetic\\项目甲' },
    { seq: 1, ts: new Date('2026-09-15T12:00:00+08:00').getTime(), input_tokens: 300, provider: '合成供应商乙', model: '合成模型乙', source: 'claude-code', cwd: 'D:\\Synthetic\\项目乙' },
    { seq: 2, ts: new Date('2026-10-05T12:00:00+08:00').getTime(), input_tokens: 9999, provider: '合成供应商甲', model: '合成模型甲', source: 'codex', cwd: 'D:\\Synthetic\\项目甲' },
  ].map(record => ({ ...record, event_id: 'reports-live-fixture:' + record.seq, session_id: 'reports-live-fixture', output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 }))
  const ingested = await fetch(server.url + '/api/v1/token-usage', { method: 'POST', headers, body: JSON.stringify({ schemaVersion: 1, client: {}, generatedAt: new Date().toISOString(), records }), signal: AbortSignal.timeout(20_000) })
  check(ingested.status === 200, 'fixture-ingest-http')
  const truth = await json<{ totalTokens: number }>(`/api/v1/stats/overview?from=${from}&to=${to}&identity_view=member`)
  check(truth.totalTokens === 425, 'fixture-september-sql-total')
  const octTruth = await json<{ totalTokens: number }>(`/api/v1/stats/overview?from=${new Date('2026-10-01T00:00:00+08:00').getTime()}&to=${new Date('2026-10-31T23:59:59.999+08:00').getTime()}&identity_view=member`)
  check(octTruth.totalTokens === 9999, 'fixture-october-window-sentinel')

  for (const scenario of scenarios) {
    phase = scenario.id
    const started = performance.now()
    const summary: Record<string, unknown> = { scenario: scenario.id, prompt: scenario.prompt, status: 'FAIL', timeout_ms: 120_000 }
    try {
      requestCount++
      const response = await fetch(server.url + '/api/v1/assistant/chat', { method: 'POST', headers, body: JSON.stringify({ prompt: scenario.prompt, page: '/overview' }), signal: AbortSignal.timeout(120_000) })
      check(response.status === 200, 'chat-http')
      const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as AssistantEvent)
      const tools = events.filter(event => event.type === 'tool')
      summary.tools = tools.map(tool => ({ tool: tool.tool, status: tool.status, state: tool.state }))
      const displays = events.filter(event => event.type === 'result').map(event => event.result)
      summary.windows = displays.map(display => ({ tool: display.tool, from: Number(new URLSearchParams(display.query).get('from')), to: Number(new URLSearchParams(display.query).get('to')), by: new URLSearchParams(display.query).get('by') }))
      check(!events.some(event => event.type === 'error'), 'chat-runtime-error')
      check(events.some(event => event.type === 'done'), 'chat-done')
      const completed = tools.filter(tool => tool.tool === 'generate_management_report' && tool.state === 'completed' && tool.status === 200)
      check(completed.length === 1, 'report-tool-success-once')
      const began = tools.find(tool => tool.tool === 'generate_management_report' && tool.state === 'running')
      check(began && began.call_id === completed[0]!.call_id, 'report-tool-progress-paired')
      check(!tools.some(tool => tool.tool === 'share_html'), 'no-public-share-tool')
      const session = events.find(event => event.type === 'session')
      check(session?.type === 'session', 'private-session-created')
      const artifacts = events.filter(event => event.type === 'artifact').map(event => event.artifact)
      check(artifacts.length === 1, 'report-file-once')
      const artifact = artifacts[0]!
      summary.artifact = { format: artifact.format, size_bytes: artifact.size_bytes, shared: !!artifact.share }
      check(artifact.format === scenario.format && artifact.title.includes(scenario.title), 'requested-preset-and-format')
      check(!artifact.share && artifact.session_id === session.session.session_id, 'private-artifact-metadata')
      check(displays.length === 4 && new Set(displays.map(display => display.dataset_id)).size === 4, 'report-four-independent-sections')
      check(isDeepStrictEqual(displays.filter(display => display.tool === 'stats_breakdown').map(display => new URLSearchParams(display.query).get('by')).sort(), [...scenario.dimensions].sort()), 'requested-breakdown-dimensions')
      check(displays.some(display => display.tool === 'stats_series') && displays.some(display => display.tool === 'stats_overview'), 'overview-and-day-trend')

      const store = new AssistantStore(join(root, 'assistant'))
      const datasets = new AssistantDatasets(join(store.sessionPath(principal.memberId, session.session.session_id), 'dsh'))
      await datasets.load()
      const snapshots: AssistantResult[] = []
      for (const display of displays) {
        const params = new URLSearchParams(display.query)
        check(Number(params.get('from')) === from && Number(params.get('to')) === to && !params.has('period'), 'every-section-exact-september-window')
        check(params.get('identity_view') === 'member', 'every-section-member-identity-view')
        check(display.dataset_id, 'section-dataset-id')
        const snapshot = datasets.render('table', { dataset_id: display.dataset_id }, principal)
        check(snapshot.table && snapshot.table.total_rows === snapshot.table.rows.length, 'fixture-full-persisted-dataset')
        const endpoint = snapshot.tool.replace(/^stats_/, '')
        const sql = await json<unknown>(`/api/v1/stats/${endpoint}?${snapshot.query}`)
        const expected = presentAssistantResult(endpoint, snapshot.query, sql)
        check(isDeepStrictEqual(snapshot.table, expected.table), 'every-section-sql-equality')
        snapshots.push(snapshot)
      }
      const overview = snapshots.find(snapshot => snapshot.tool === 'stats_overview')!
      check(overview.table?.rows[0]?.total_tokens === 425, 'report-total-425')
      check(displays.find(display => display.tool === 'stats_overview')?.cards?.some(card => card.label === '计费总量' && card.value === '425'), 'display-overview-total-425')
      const history = await json<AssistantDetail>('/api/v1/assistant/sessions/' + session.session.session_id)
      const diskHistory = await new AssistantStore(join(root, 'assistant')).get(principal.memberId, session.session.session_id)
      check(isDeepStrictEqual(history, diskHistory), 'history-http-and-disk-equality')
      check(isDeepStrictEqual(history.messages.flatMap(message => message.results ?? []), displays), 'history-persists-all-report-sections')
      check(isDeepStrictEqual(history.messages.flatMap(message => message.artifacts ?? []), artifacts), 'history-persists-private-file')
      check(history.messages[0]?.text === scenario.prompt, 'history-preserves-original-request')
      check(history.messages.some(message => message.role === 'assistant' && message.text.trim()), 'assistant-explains-completed-report')

      const downloadPath = '/api/v1/assistant/artifacts/' + artifact.artifact_id + '/download'
      const download = await fetch(server.url + downloadPath, { headers, signal: AbortSignal.timeout(20_000) })
      check(download.status === 200, 'authorized-file-download')
      const bytes = Buffer.from(await download.arrayBuffer())
      check(bytes.length === artifact.size_bytes, 'download-size-matches-metadata')
      check((await fetch(server.url + downloadPath, { signal: AbortSignal.timeout(20_000) })).status === 401, 'anonymous-file-download-denied')
      if (scenario.format === 'xlsx') {
        check(download.headers.get('content-type')?.includes('spreadsheetml'), 'xlsx-download-mime')
        const entries = unzip(bytes), workbook = entries['xl/workbook.xml'] ?? ''
        check([...workbook.matchAll(/<sheet name=/g)].length === 5 && workbook.includes('name="说明"'), 'xlsx-all-sections-and-explanation')
        for (const [index, snapshot] of snapshots.entries()) {
          const expected = [snapshot.table!.columns.map(column => column.label), ...snapshot.table!.rows.map(row => snapshot.table!.columns.map(column => row[column.key] ?? null))]
          check(isDeepStrictEqual(sheetRows(entries[`xl/worksheets/sheet${index + 1}.xml`] ?? ''), expected), 'xlsx-every-cell-matches-sql-dataset')
        }
        const explanations = entries['xl/worksheets/sheet5.xml'] ?? ''
        check(decodeXml(explanations).includes(`from=${from}`) && decodeXml(explanations).includes(`to=${to}`), 'xlsx-preserves-frozen-query-window')
      } else {
        check(download.headers.get('content-type')?.includes('text/html'), 'html-download-mime')
        const html = bytes.toString()
        check(!html.includes('<script') && !html.includes('<form'), 'html-static-private-report')
        const sections = [...html.matchAll(/<section><h2>([\s\S]*?)<\/h2><pre>[\s\S]*?<\/pre>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>[\s\S]*?<\/section>/g)]
        check(sections.length === snapshots.length, 'html-all-sections')
        for (const [index, snapshot] of snapshots.entries()) {
          check(decodeXml(sections[index]![1]!) === snapshot.title, 'html-section-title')
          const exported = [...sections[index]![2]!.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(row => [...row[1]!.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(cell => decodeXml(cell[1]!)))
          const expected = snapshot.table!.rows.map(row => snapshot.table!.columns.map(column => String(row[column.key] ?? '')))
          check(isDeepStrictEqual(exported, expected), 'html-every-cell-matches-sql-dataset')
        }
        check(decodeXml(html).includes(`from=${from}`) && decodeXml(html).includes(`to=${to}`), 'html-preserves-frozen-query-window')
      }
      await writeFile(join(outputDirectory, scenario.id + '.' + scenario.format), bytes)
      const storedArtifacts = history.messages.flatMap(message => message.artifacts ?? []) as AssistantArtifact[]
      check(storedArtifacts.every(item => !item.share), 'history-no-public-sharing')
      summary.status = 'PASS'; summary.total_tokens = 425; summary.sections = snapshots.length; summary.sql_equal = true; summary.history_persisted = true; summary.private_download = true
    } catch (error) {
      summary.check = error instanceof VerificationFailure ? error.check : error instanceof DOMException && error.name === 'TimeoutError' ? 'scenario-timeout' : 'model-or-service-failure'
      process.exitCode = 1
    }
    summary.elapsed_ms = Math.round(performance.now() - started)
    results.push(summary)
    log('REPORTS_LIVE_SCENARIO ' + JSON.stringify(summary))
    await writeFile(join(outputDirectory, 'latest.json'), JSON.stringify({ source: 'real-model', synthetic_data_only: true, created_at: new Date().toISOString(), status: results.every(result => result.status === 'PASS') ? 'PASS' : 'FAIL', from, to, model_chat_requests: requestCount, automatic_retries: 0, results }, null, 2))
  }
  log('REPORTS_LIVE_' + (results.every(result => result.status === 'PASS') ? 'OK' : 'FAILED') + ': 两个独立真实中文场景已各执行一次；结果保存到 .artifacts/assistant-reports-live/latest.json。')
} catch (error) {
  process.exitCode = 1
  const failedCheck = error instanceof VerificationFailure ? error.check : 'fixture-or-service-failure'
  log('REPORTS_LIVE_FAILED: ' + phase + ' / ' + failedCheck + '；未输出原始错误、请求头或凭证。')
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(join(outputDirectory, 'latest.json'), JSON.stringify({ source: 'real-model', synthetic_data_only: true, status: 'FAIL', phase, check: failedCheck, model_chat_requests: requestCount, automatic_retries: 0, results }, null, 2))
} finally {
  if (server) await server.stop()
  const resolvedRoot = resolve(root)
  if (!resolvedRoot.startsWith(join(resolve(tmpdir()), 'atr-assistant-reports-live-'))) throw new VerificationFailure('cleanup-outside-fixture-boundary')
  for (let attempt = 0; ; attempt++) {
    try { await rm(resolvedRoot, { recursive: true, force: true }); break }
    catch (error) {
      if (attempt >= 20 || !['EBUSY', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new VerificationFailure('fixture-cleanup-failed')
      await new Promise(done => setTimeout(done, 100))
    }
  }
  Object.assign(console, runtimeConsole)
}
