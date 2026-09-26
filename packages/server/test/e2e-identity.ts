/**
 * 端到端验证：真实 HTTP 走通「署名」全链路。
 *
 * 与单元测试的区别：这里**真的起两个 HTTP 服务**，
 * 验证的是「跨进程的真实请求」，而不是注入的假 fetch。
 *
 * 流程：
 *   1. 起「部门服务端」，配置凭证
 *   2. 起「本地服务」，指向部门服务端
 *   3. 模拟页面：GET 未署名 → POST 错误 token → POST 正确 token → GET 已署名
 *   4. 验证身份文件真的落盘，且内容以服务端认定的姓名为准
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createServer } from '../src/index.js'
import { seedDatabaseIdentity } from './database-fixture.js'

const home = mkdtempSync(join(tmpdir(), 'atr-e2e-'))

// ── 准备凭证 ────────────────────────────────────────────────
mkdirSync(join(home, 'token-report'), { recursive: true })
const credPath = join(home, 'token-report', 'credentials.json')
writeFileSync(
  credPath,
  JSON.stringify([{ token: 'atr-zhangsan-9f3c', name: '张三', dept: '研发一部' }]),
  'utf8',
)
await seedDatabaseIdentity({ sqlitePath: join(home, 'token-report', 'portal.sqlite') }, [
  { token: 'atr-zhangsan-9f3c', name: '张三', dept: '研发一部' },
])

let passed = 0
let failed = 0

function check(label: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

// ── 1. 起部门服务端 ─────────────────────────────────────────
console.log('\n【1】启动部门服务端')
const portal = await createServer({
  port: 18787,
  host: '127.0.0.1',
  dshHome: home,
  mysqlUrl: '',
  enableLocalApi: false,
})
console.log(`  部门服务端: ${portal.url}`)

const health = await (await fetch(`${portal.url}/api/health`)).json()
check('健康检查返回身份已入库', health.initialized === true)
check('schema为v4', health.schema_version === 4)

// ── 2. 直接验证校验端点 ─────────────────────────────────────
console.log('\n【2】部门服务端的校验端点')
const okRes = await (
  await fetch(`${portal.url}/api/v1/identity/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer atr-zhangsan-9f3c' },
    body: JSON.stringify({ token: 'atr-zhangsan-9f3c' }),
  })
).json()
check('正确 token → ok', okRes.ok === true)
check('返回姓名来自凭证表', okRes.name === '张三', JSON.stringify(okRes))
check('返回部门', okRes.dept === '研发一部')

const badRes = await (
  await fetch(`${portal.url}/api/v1/identity/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
    body: JSON.stringify({ token: 'wrong-token' }),
  })
).json()
check('错误 token → ok=false', badRes.ok === false)
check('错误 token 提示注册状态为 true（用户重试有用）', badRes.registered === true)

// ── 3. 起本地服务，指向部门服务端 ───────────────────────────
console.log('\n【3】启动本地服务（指向部门服务端）')
const local = await createServer({
  port: 18788,
  host: '127.0.0.1',
  dshHome: home,
  portalUrl: portal.url,
  enableLocalApi: true,
})
console.log(`  本地服务: ${local.url}`)

// ── 4. 模拟页面署名流程 ─────────────────────────────────────
console.log('\n【4】模拟页面署名流程')

const before = await (await fetch(`${local.url}/api/local/identity`)).json()
check('首次 GET → signed=false', before.signed === false)
check('首次 GET → 带引导提示', typeof before.hint === 'string' && before.hint.length > 0)

// 4.1 先填一个错误 token
const wrongSubmit = await (
  await fetch(`${local.url}/api/local/identity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '张三', token: 'wrong-token' }),
  })
).json()
check('错误 token 提交 → ok=false', wrongSubmit.ok === false)
check('给出可展示的原因', typeof wrongSubmit.reason === 'string')

// 4.2 关键：此时不应落盘
let identityFileExists = true
try {
  readFileSync(join(home, 'token-report', 'identity.json'), 'utf8')
} catch {
  identityFileExists = false
}
check('★ 校验失败时未落盘', identityFileExists === false)

// 4.3 填正确 token，且故意把姓名写错（验证以服务端为准）
const goodSubmit = await (
  await fetch(`${local.url}/api/local/identity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '张三三（用户打错）', token: 'atr-zhangsan-9f3c' }),
  })
).json()
check('正确 token 提交 → ok=true', goodSubmit.ok === true)
check('★ 姓名以服务端认定为准，而非用户输入', goodSubmit.name === '张三', String(goodSubmit.name))
check('部门来自凭证表', goodSubmit.dept === '研发一部')

// 4.4 落盘内容验证
const stored = JSON.parse(readFileSync(join(home, 'token-report', 'identity.json'), 'utf8'))
check('落盘姓名 = 张三', stored.name === '张三')
check('落盘部门 = 研发一部', stored.dept === '研发一部')
check('落盘 token', stored.token === 'atr-zhangsan-9f3c')
check('落盘含 createdAt', typeof stored.createdAt === 'number')

// 4.5 再 GET 应显示已署名
const after = await (await fetch(`${local.url}/api/local/identity`)).json()
check('署名后 GET → signed=true', after.signed === true)
check('署名后 GET → name=张三', after.name === '张三')
check('★ 署名后 GET 响应不含 token', !JSON.stringify(after).includes('atr-zhangsan-9f3c'))

// ── 5. 端口占用自动重试 ─────────────────────────────────────
console.log('\n【5】端口占用自动重试')
const second = await createServer({
  port: 18788, // 已被 local 占用
  host: '127.0.0.1',
  dshHome: home,
  enableLocalApi: true,
})
check('端口被占用时自动换端口', second.port === 18789, `实际 ${second.port}`)
check('portShifted 标记为 true', second.portShifted === true)
await second.stop()

// ── 6. 静态托管的健壮性（仅当构建产物存在时）────────────────
console.log('\n【6】静态托管健壮性')
const staticProbe = await createServer({
  port: 0,
  host: '127.0.0.1',
  dshHome: home,
  enableLocalApi: true,
  staticDir: 'packages/web-local/dist',
})
check('端口 0 回传系统分配的真实端口', staticProbe.port > 0, `实际 ${staticProbe.port}`)
check('系统分配端口不算占用重试', staticProbe.portShifted === false)

// 目录穿越：绝不应泄露 dist 之外的文件
const traversal = await fetch(`${staticProbe.url}/../../package.json`)
const traversalBody = await traversal.text()
check('★ 目录穿越不泄露文件', !traversalBody.includes('"ai-token-report"'))

// 非法 URL 编码：应为 400（客户端错误），不是 500（服务缺陷）
const malformed = await fetch(`${staticProbe.url}/%zz`)
check('★ 非法 URL 编码返回 400 而非 500', malformed.status === 400, `实际 ${malformed.status}`)

await staticProbe.stop()

// ── 7. 清除署名 ─────────────────────────────────────────────
console.log('\n【7】清除署名')
await fetch(`${local.url}/api/local/identity`, { method: 'DELETE' })
const cleared = await (await fetch(`${local.url}/api/local/identity`)).json()
check('清除后 signed=false', cleared.signed === false)

// ── 清理 ────────────────────────────────────────────────────
await local.stop()
await portal.stop()
rmSync(home, { recursive: true, force: true })

console.log(`\n${'─'.repeat(50)}`)
console.log(`结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed > 0 ? 1 : 0)
