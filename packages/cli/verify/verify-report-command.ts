/**
 * 真正启动 CLI 进程，验证署名门禁、故障补投与服务端确认语义。
 * 源码与发布产物共用场景；所有凭证、日志、状态及库都在临时目录。
 * `bun run packages/cli/verify/verify-report-command.ts [--package]`
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { createServer, type ServerHandle } from '@ai-token-report/server'
import { preparePortalDatabase } from '@ai-token-report/core/db'
import { IdentityRepository } from '../../server/src/identity/repository.js'
import { loadState, writeIdentity } from '@ai-token-report/core'
import { cleanChildEnv, resolveNodeBin } from '../../core/verify/lib/runtime.js'

const packageMode = process.argv.includes('--package')
const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(pkg, packageMode ? 'dist/cli.js' : 'src/cli.ts')
const node = packageMode ? resolveNodeBin() : null
if (packageMode && !node) throw new Error('发布产物验证需要真实 Node')
const runtimes = packageMode ? [['Node', node!], ['Bun', process.execPath]] : [['源码 Bun', process.execPath]]
const fixture = mkdtempSync(join(tmpdir(), 'atr-cli-command-'))
const token = 'atr-cli-fixture-token'
const env = cleanChildEnv()
for (const key of Object.keys(env)) {
  if (key.startsWith('DSH_REPORT_') || key.startsWith('ATR_')) delete env[key]
}
let passed = 0
let failed = 0
function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`)
  if (ok) passed++
  else failed++
}

function makeHome(name: string, signed = false): string {
  const home = join(fixture, name)
  const sessionDir = join(home, 'sessions', 'project', name)
  mkdirSync(sessionDir, { recursive: true })
  const lines = [
    { type: 'session', version: 3, id: name, createdAt: Date.now(), cwd: 'D:/fixture' },
    ...[1, 2].map(seq => ({
      type: 'assistant/message', seq, time: Date.now(),
      data: {
        turn: 1, step: seq,
        message: { source: { kind: 'model', provider: 'fixture', model: 'fixture-model' } },
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 10, totalTokens: 1030 },
      },
    })),
  ]
  writeFileSync(join(sessionDir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.map(line => JSON.stringify(line)).join('\n') + '\n')))
  if (signed) writeIdentity(join(home, 'token-report', 'identity.json'), { name: '客户端自称', token })
  return home
}

function statePath(home: string): string { return join(home, 'token-report', 'state.json') }
function pending(home: string): number { return loadState(statePath(home)).state.pending.length }

async function run(bin: string, home: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([bin, cli, 'report', '--dsh-home', home, '--quiet', ...args], {
    stdout: 'pipe', stderr: 'pipe', env,
  })
  // 响应头已到但 body 永不结束时也要能失败；上限只用于回归脚本防挂死。
  const timer = setTimeout(() => proc.kill(), 5000)
  try {
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { code, out: out + err }
  } finally { clearTimeout(timer) }
}

const portalHome = join(fixture, 'portal')
mkdirSync(portalHome, { recursive: true })
const target = { sqlitePath: join(portalHome, 'portal.sqlite') }
await preparePortalDatabase(target)
await new IdentityRepository(target).importCredentials([
  { token: 'report-command-admin', name: '测试管理员', role: 'admin' },
  { token, name: '服务端身份', dept: '验证部门' },
], 'verify-report-command')
const portalOptions = {
  port: 18804, host: '127.0.0.1', dshHome: portalHome,
  dbPath: target.sqlitePath, mysqlUrl: '', enableLocalApi: false,
}
let portal: ServerHandle | undefined
let requests = 0
let receipt: () => Response = () => Response.json({ accepted: 2, duplicates: 0, rejected: 0 })
const receiver = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 10, fetch: () => { requests++; return receipt() } })
const receiptEndpoint = `http://127.0.0.1:${receiver.port}/api/v1/token-usage`

try {
  portal = await createServer(portalOptions)
  for (const [label, bin] of runtimes) {
    if (!bin) throw new Error('运行时缺失')
    console.log(`\n【${label}】真实 CLI 进程 → HTTP → 状态 / 数据库`)
    const unsigned = makeHome(`${label}-unsigned`)
    let before = requests
    let result = await run(bin, unsigned, ['--endpoint', receiptEndpoint])
    check('未署名正常跳过，不发请求、不创建上报状态', result.code === 0 && requests === before && !existsSync(statePath(unsigned)) && result.out.includes('未署名'))
    const corrupt = makeHome(`${label}-corrupt`)
    mkdirSync(join(corrupt, 'token-report'), { recursive: true })
    writeFileSync(join(corrupt, 'token-report', 'identity.json'), '{broken')
    before = requests
    result = await run(bin, corrupt, ['--endpoint', receiptEndpoint])
    check('身份文件损坏降级跳过，有提示且不采集', result.code === 0 && requests === before && !existsSync(statePath(corrupt)) && result.out.includes('身份文件'))

    const signed = makeHome(`${label}-signed`, true)
    let endpoint = `${portal.url}/api/v1/token-usage`
    result = await run(bin, signed, ['--endpoint', endpoint])
    check('共享 identity.json 可直接完成上报', result.code === 0 && pending(signed) === 0 && result.out.includes('接受 2'))
    result = await run(bin, signed, ['--endpoint', endpoint])
    check('无新增时再次执行不重复投递', result.code === 0 && result.out.includes('本轮无新增'))
    const fresh = makeHome(`${label}-retry`, true)
    result = await run(bin, fresh, ['--endpoint', endpoint, '--token', 'wrong-token'])
    check('显式 token 优先；401 退出 3 且完整保留 pending', result.code === 3 && pending(fresh) === 2)
    result = await run(bin, fresh, ['--endpoint', endpoint])
    check('下一进程从磁盘恢复 pending 并成功补投', result.code === 0 && pending(fresh) === 0 && result.out.includes('接受 2'))
    await run(bin, fresh, ['--reset'])
    result = await run(bin, fresh, ['--endpoint', endpoint])
    check('清状态全量重发由服务端幂等去重', result.code === 0 && result.out.includes('重复 2') && pending(fresh) === 0)

    const offline = makeHome(`${label}-offline`, true)
    await portal.stop()
    portal = undefined
    result = await run(bin, offline, ['--endpoint', endpoint, '--timeout', '200'])
    check('真实断网退出 3，待发记录仍在磁盘', result.code === 3 && pending(offline) === 2)
    portal = await createServer(portalOptions)
    endpoint = `${portal.url}/api/v1/token-usage`
    result = await run(bin, offline, ['--endpoint', endpoint])
    check('服务恢复后无需新日志即可补投', result.code === 0 && pending(offline) === 0 && result.out.includes('接受 2'))

    const partial = makeHome(`${label}-partial`, true)
    await run(bin, partial, ['--dry-run'])
    const staged = JSON.parse(readFileSync(statePath(partial), 'utf8'))
    staged.pending[0].usage.input = -1
    writeFileSync(statePath(partial), JSON.stringify(staged))
    result = await run(bin, partial, ['--endpoint', endpoint])
    check('首行被拒而次行接受时，不按位置误删首行', result.code === 3 && pending(partial) === 2)
    const retained = JSON.parse(readFileSync(statePath(partial), 'utf8'))
    if (retained.pending[0]?.seq === 1) retained.pending[0].usage.input = 100
    writeFileSync(statePath(partial), JSON.stringify(retained))
    result = await run(bin, partial, ['--endpoint', endpoint])
    check('修正拒收记录后重放，接受与重复计数共同完成确认', result.code === 0 && pending(partial) === 0 && result.out.includes('接受 1，重复 1'))

    const badReceipts: [string, () => Response][] = [
      ['空响应', () => new Response('')],
      ['HTML 页面', () => new Response('<html>login</html>')],
      ['缺少计数', () => Response.json({ ok: false })],
      ['计数不等于批次数', () => Response.json({ accepted: 1, duplicates: 0, rejected: 0 })],
      ['负数计数', () => Response.json({ accepted: 3, duplicates: -1, rejected: 0 })],
      ['小数计数', () => Response.json({ accepted: 1.5, duplicates: 0.5, rejected: 0 })],
      ['响应体超时', () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) } }))],
    ]
    for (const [name, respond] of badReceipts) {
      const home = makeHome(`${label}-${name}`, true)
      receipt = respond
      result = await run(bin, home, ['--endpoint', receiptEndpoint, '--timeout', '150'])
      check(`错误 2xx：${name} 不确认、不丢 pending`, result.code === 3 && pending(home) === 2)
    }
    receipt = () => Response.json({ accepted: 2, duplicates: 0, rejected: 0 })
    const explicit = makeHome(`${label}-explicit`)
    result = await run(bin, explicit, ['--endpoint', endpoint, '--token', token])
    check('显式 token 可独立授权上报，无需重复署名', result.code === 0 && pending(explicit) === 0 && result.out.includes('接受 2'))
  }
} finally {
  await portal?.stop()
  receiver.stop(true)
  rmSync(fixture, { recursive: true, force: true })
}
console.log(`\n真实 CLI 上报：${passed} 项通过，${failed} 项失败`)
process.exitCode = failed ? 1 : 0
