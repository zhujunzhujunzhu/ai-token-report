/**
 * 端到端验证：真实 HTTP 走通「署名」全链路。
 *
 * 与单元测试的区别：这里**真的起两个 HTTP 服务**，
 * 验证的是「跨进程的真实请求」，而不是注入的假 fetch。
 *
 * 流程：
 *   1. 起「部门服务端」，配置凭证
 *   2. 起「本地服务」（**不配 `--portal`**：地址由页面提交，与插件同一形态）
 *   3. 模拟页面：GET 未署名 → POST 错误 appKey → POST 正确 appKey → GET 已署名
 *   4. 验证身份与连接配置真的落盘（连接那份与插件**共用同一个文件**）
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createServer } from '../src/index.js'
import { PORTAL_SCHEMA_VERSION } from '@ai-token-report/core/db'
import { seedDatabaseIdentity } from './database-fixture.js'

const home = mkdtempSync(join(tmpdir(), 'atr-e2e-'))
// ★ 数据目录**不跟随 DSH_HOME**：缺省在家目录下（~/.ai-token-report）。
//   本脚本断言服务端把署名写进 fixture，所以必须显式指到 fixture ——
//   否则它会去改写使用者真实的 identity.json。
const DATA_DIR = join(home, 'token-report')

// ── 准备凭证 ────────────────────────────────────────────────
mkdirSync(join(home, 'token-report'), { recursive: true })
const credPath = join(DATA_DIR, 'credentials.json')
writeFileSync(
  credPath,
  JSON.stringify([{ token: 'atr-zhangsan-9f3c', name: '张三', group: '研发一部' }]),
  'utf8',
)
await seedDatabaseIdentity({ sqlitePath: join(DATA_DIR, 'portal.sqlite') }, [
  { token: 'atr-zhangsan-9f3c', name: '张三', group: '研发一部' },
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
  dataDir: DATA_DIR,
  mysqlUrl: '',
  enableLocalApi: false,
})
console.log(`  部门服务端: ${portal.url}`)

const health = await (await fetch(`${portal.url}/api/health`)).json()
check('健康检查返回身份已入库', health.initialized === true)
// ★ 跟常量走而不是写死数字：写死 4 会让每次部署都误报「上报库 schema 版本不一致」，
//   而 `deploy-server.mjs` 正是拿这个字段和本地代码期望的版本比对。
check(`schema为v${PORTAL_SCHEMA_VERSION}`, health.schema_version === PORTAL_SCHEMA_VERSION)

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
check('返回分组', okRes.group === '研发一部')
// ★ `dept` 是刻意保留的兼容别名：已部署的旧插件 / 旧 CLI 读的是它。
//   两者必须**同值**，否则同一份响应里会出现两个互相矛盾的分组名。
check('★ 旧字段名 dept 仍返回且与 group 同值（兼容旧插件）', okRes.dept === '研发一部' && okRes.dept === okRes.group)

const badRes = await (
  await fetch(`${portal.url}/api/v1/identity/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
    body: JSON.stringify({ token: 'wrong-token' }),
  })
).json()
check('错误 token → ok=false', badRes.ok === false)
check('错误 token 提示注册状态为 true（用户重试有用）', badRes.registered === true)

// ── 3. 起本地服务（地址由页面提交，不配 --portal）───────────
console.log('\n【3】启动本地服务（不配 --portal：地址由页面填）')
// ★ 刻意**不配 `portalUrl`**：地址由「配置」弹框里的「服务端地址」那一栏提交，
//   这正是「只需要一个 baseUrl + appKey」的意思。部署参数只是缺省值。
const local = await createServer({
  port: 18788,
  host: '127.0.0.1',
  dshHome: home,
  dataDir: DATA_DIR,
  enableLocalApi: true,
})
console.log(`  本地服务: ${local.url}`)

// ── 4. 模拟页面配置流程 ─────────────────────────────────────
console.log('\n【4】模拟页面配置流程（服务端地址 + appKey）')

const before = await (await fetch(`${local.url}/api/local/identity`)).json()
check('首次 GET → signed=false', before.signed === false)
check('首次 GET → 带引导提示', typeof before.hint === 'string' && before.hint.length > 0)
check('★ 首次 GET → 地址为 null（页面必须让用户填）', before.baseUrl === null)

// 4.1 先填一个错误 appKey（地址按用户会粘贴的样子：完整上报地址 + 尾斜杠）
const wrongSubmit = await (
  await fetch(`${local.url}/api/local/identity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'wrong-token', baseUrl: `${portal.url}/api/v1/token-usage/` }),
  })
).json()
check('错误 appKey 提交 → ok=false', wrongSubmit.ok === false)
check('给出可展示的原因', typeof wrongSubmit.reason === 'string')

// 4.2 关键：此时不应落盘（身份与连接都不该留下）
const readIfExists = (name: string): string | null => {
  try {
    return readFileSync(join(DATA_DIR, name), 'utf8')
  } catch {
    return null
  }
}
check('★ 校验失败时未落盘身份', readIfExists('identity.json') === null)
check('★ 校验失败时未落盘连接配置', readIfExists('plugin-connection.json') === null)

// 4.3 填正确 appKey；同时故意多塞一个姓名字段（验证以服务端为准）
const goodSubmit = await (
  await fetch(`${local.url}/api/local/identity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: 'atr-zhangsan-9f3c',
      baseUrl: `${portal.url}/api/v1/token-usage/`,
      name: '张三三（用户打错）',
    }),
  })
).json()
check('正确 appKey 提交 → ok=true', goodSubmit.ok === true)
check('★ 姓名以服务端认定为准，而非请求里塞的', goodSubmit.name === '张三', String(goodSubmit.name))
check('分组来自凭证表', goodSubmit.group === '研发一部')
check('★ 回显的地址已归一化（剥掉接口后缀与尾斜杠）', goodSubmit.baseUrl === portal.url, String(goodSubmit.baseUrl))

// 4.4 落盘内容验证
const stored = JSON.parse(readFileSync(join(DATA_DIR, 'identity.json'), 'utf8'))
check('落盘姓名 = 张三', stored.name === '张三')
check('落盘分组 = 研发一部（只写新字段 group）', stored.group === '研发一部' && !('dept' in stored))
check('落盘 token', stored.token === 'atr-zhangsan-9f3c')
check('落盘含 createdAt', typeof stored.createdAt === 'number')

// ★ 连接配置与插件**共用同一份文件**：在本地页填一次，插件读到的是同一个地址与凭证。
const connection = JSON.parse(readFileSync(join(DATA_DIR, 'plugin-connection.json'), 'utf8'))
check('★ 连接配置落盘 baseUrl（与插件同一份文件）', connection.baseUrl === portal.url, JSON.stringify(connection))
check('★ 连接配置落盘 appKey', connection.appKey === 'atr-zhangsan-9f3c')

// 4.5 再 GET 应显示已署名，并回填地址
const after = await (await fetch(`${local.url}/api/local/identity`)).json()
check('署名后 GET → signed=true', after.signed === true)
check('署名后 GET → name=张三', after.name === '张三')
check('署名后 GET → 回填服务端地址', after.baseUrl === portal.url)
check('★ 署名后 GET 响应不含 token', !JSON.stringify(after).includes('atr-zhangsan-9f3c'))

// 4.6 只补 appKey、地址留空 → 复用本机存过的地址（页面不必每次重填）
const reuseSubmit = await (
  await fetch(`${local.url}/api/local/identity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'atr-zhangsan-9f3c' }),
  })
).json()
check('★ 地址留空 → 复用已保存的地址，保存成功', reuseSubmit.ok === true && reuseSubmit.baseUrl === portal.url)

// ── 5. 端口占用自动重试 ─────────────────────────────────────
console.log('\n【5】端口占用自动重试')
const second = await createServer({
  port: 18788, // 已被 local 占用
  host: '127.0.0.1',
  dshHome: home,
  dataDir: DATA_DIR,
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
  dataDir: DATA_DIR,
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
