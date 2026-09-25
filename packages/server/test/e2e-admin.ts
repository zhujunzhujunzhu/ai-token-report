/**
 * 端到端验证：真实 HTTP 走通「人员管理 + token 发放」全链路。
 *
 * 与 `member-admin.test.ts` 的区别：那个直接调 `MemberAdmin` / `AdminRoute`，
 * 这里**真的起一个 HTTP 服务**，用真实 `fetch` 打 `/api/v1/admin/members*`，
 * 并回到库与文件上核对结果。它覆盖的是「只有跨进程才暴露」的东西：
 * 路由挂载、方法限制、`/api/v1/admin/members` 与子路径的分发、
 * 以及**签发出来的 token 立刻能上报、能看看板**这条端到端性质。
 *
 * ```
 * bun run packages/server/test/e2e-admin.ts
 * ```
 *
 * ★ 最关键的一条断言是「签发即刻生效」：
 *   管理员在页面上拿到 token 的那一刻就会发给员工，
 *   若服务端要重启才认这个 token，员工那边看到的是「token 无效」——
 *   而管理员这边一切正常，排障方向会被完全带偏。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AdminMemberResponse, AdminMembersResponse } from '@ai-token-report/shared'

import { createServer } from '../src/index.js'

const PORT = 18811
/** 环境变量注入的管理员 —— 冷启动兜底那条路（凭证文件为空/只读时唯一的入口）。 */
const ENV_ADMIN_TOKEN = 'atr-env-admin-0001'
const BOSS_TOKEN = 'atr-boss-9f3c'
const ZHANG_TOKEN = 'atr-zhangsan-9f3c'

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

/**
 * 发一个请求并把响应解析成 JSON（非 JSON 也照原样返回，便于断言状态码）。
 *
 * ⚠️ `body` 用 `any`：这是一个验证脚本，每个断言都按当时的响应形状就地取值，
 *   为它写一套响应类型只会把注意力从「端到端行为」引开。
 *   类型契约的守卫在 `shared/src/protocol.ts` 与各 `*.test.ts`。
 */
async function call(
  url: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    /* 非 JSON 响应也照原样返回，让断言能看到 status */
  }
  return { status: res.status, body: parsed, headers: res.headers }
}

/** 一条线上记录（下划线字段，四个 token 分列）。 */
function record(eventId: string): Record<string, unknown> {
  return {
    event_id: eventId,
    session_id: 'session-e2e-admin',
    seq: 1,
    ts: Date.now(),
    provider: 'dashscope',
    model: 'deepseek-v4.1-flash',
    input_tokens: 100,
    output_tokens: 10,
    cache_read_tokens: 900,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 1010,
    cwd: 'D:\\Coding\\ai-token-report',
    turn: 1,
    step: 1,
  }
}

function ingestPayload(eventId: string): unknown {
  return {
    schemaVersion: 1,
    client: { userId: 'ignored', userName: 'ignored' },
    generatedAt: new Date().toISOString(),
    records: [record(eventId)],
  }
}

// ── 0. 准备：一个手工维护的凭证文件（一个管理员 + 一个成员）───────────────
const home = mkdtempSync(join(tmpdir(), 'atr-e2e-admin-'))
mkdirSync(join(home, 'token-report'), { recursive: true })
const credPath = join(home, 'token-report', 'credentials.json')
const dbPath = join(home, 'token-report', 'portal.sqlite')
writeFileSync(
  credPath,
  JSON.stringify([
    { token: BOSS_TOKEN, name: '李经理', dept: '研发一部', role: 'admin' },
    { token: ZHANG_TOKEN, name: '张三', dept: '研发一部' },
  ]),
  'utf8',
)

// ── 1. 起服务 ───────────────────────────────────────────────────────────────
console.log('\n【1】启动部门服务端（凭证文件 + 环境变量管理员）')
const portal = await createServer({
  port: PORT,
  host: '127.0.0.1',
  dshHome: home,
  dbPath,
  credentialsPath: credPath,
  adminToken: ENV_ADMIN_TOKEN,
  adminName: '部署管理员',
  enableLocalApi: false,
})
const base = portal.url
const members = `${base}/api/v1/admin/members`

const health = (await (await fetch(`${base}/api/health`)).json()) as {
  credentialsRegistered: boolean
  credentialCount: number
  adminCount: number
}
check('健康检查：凭证已登记', health.credentialsRegistered === true)
check('健康检查：凭证数量 3（李经理 / 张三 / 环境变量管理员）', health.credentialCount === 3, String(health.credentialCount))
check('健康检查：管理员数量 2', health.adminCount === 2, String(health.adminCount))

// ── 2. 角色来自服务端（页面据此决定显不显示管理页签）────────────────────
console.log('\n【2】身份校验带回角色')
const bossVerify = await call(`${base}/api/v1/identity/verify`, {
  method: 'POST',
  token: BOSS_TOKEN,
  body: { token: BOSS_TOKEN },
})
check('管理员 token → role=admin', bossVerify.body?.role === 'admin', JSON.stringify(bossVerify.body))

const zhangVerify = await call(`${base}/api/v1/identity/verify`, {
  method: 'POST',
  token: ZHANG_TOKEN,
  body: { token: ZHANG_TOKEN },
})
check('★ 成员 token → role=member（绝不默认成管理员）', zhangVerify.body?.role === 'member', JSON.stringify(zhangVerify.body))

const envVerify = await call(`${base}/api/v1/identity/verify`, {
  method: 'POST',
  token: ENV_ADMIN_TOKEN,
  body: { token: ENV_ADMIN_TOKEN },
})
check('环境变量管理员 → role=admin，姓名来自配置', envVerify.body?.role === 'admin' && envVerify.body?.name === '部署管理员', JSON.stringify(envVerify.body))

// ── 3. 鉴权三类分开 ─────────────────────────────────────────────────────────
console.log('\n【3】鉴权：401 / 403 必须分开')
const noAuth = await call(members)
check('★ 缺 token → 401', noAuth.status === 401, String(noAuth.status))

const badToken = await call(members, { token: 'atr-nope' })
check('★ token 不对 → 401', badToken.status === 401, String(badToken.status))

const asMember = await call(members, { token: ZHANG_TOKEN })
check('★ 成员 token → 403（不是 401，重填没用）', asMember.status === 403, String(asMember.status))
check('403 响应体里没有人员名单', !('members' in (asMember.body ?? {})))
check('403 原因指向「要管理员 token」', String(asMember.body?.reason).includes('管理员'))

// ── 4. 人员列表 ─────────────────────────────────────────────────────────────
console.log('\n【4】人员列表（管理员）')
const list = await call(members, { token: ENV_ADMIN_TOKEN })
const listBody = list.body as AdminMembersResponse
check('HTTP 200', list.status === 200, String(list.status))
check('三人都在：李经理 / 张三 / 部署管理员', listBody.members?.length === 3, JSON.stringify(listBody.members?.map((m) => m.name)))
check('★ 管理员排在前面', listBody.members?.[0]?.role === 'admin')
check('环境变量管理员标成 source=env（页面据此禁掉操作）', listBody.members?.some((m) => m.source === 'env' && m.name === '部署管理员'))
check('token 明文返回（页面要把它发给本人）', listBody.members?.some((m) => m.token === ZHANG_TOKEN))
check('凭证文件可写', listBody.writable === true)
check('凭证文件路径与配置一致', listBody.credentialsPath === credPath)

// ── 5. ★ 签发：新 token 立刻能上报、能看看板 ────────────────────────────────
console.log('\n【5】签发新 token，并立刻用它上报')
const issued = await call(members, {
  method: 'POST',
  token: ENV_ADMIN_TOKEN,
  body: { name: '王五', dept: '研发二部' },
})
const issuedBody = issued.body as AdminMemberResponse
check('HTTP 200 + ok', issued.status === 200 && issuedBody.ok === true, JSON.stringify(issued.body))
const wangToken = issuedBody.member?.token ?? ''
check('token 形如 atr-<16 hex>', /^atr-[0-9a-f]{16}$/.test(wangToken), wangToken)
check('角色缺省是普通成员', issuedBody.member?.role === 'member')

const fileAfterIssue = JSON.parse(readFileSync(credPath, 'utf8')) as Record<string, unknown>[]
const wangEntry = fileAfterIssue.find((e) => e['name'] === '王五')
check('★ 落盘了（文件里能读出王五）', !!wangEntry)
check('成员不写 role 字段（缺省即成员）', wangEntry !== undefined && !('role' in wangEntry))
check('原来的管理员条目仍在（没有覆盖手工维护的内容）', fileAfterIssue.some((e) => e['token'] === BOSS_TOKEN && e['role'] === 'admin'))

const wangReport = await call(`${base}/api/v1/token-usage`, {
  method: 'POST',
  token: wangToken,
  body: ingestPayload('e2e-wang:1'),
})
check('★★ 新 token 立刻可上报（不必重启服务端）', wangReport.status === 200 && wangReport.body?.accepted === 1, JSON.stringify(wangReport.body))

const stats = await call(`${base}/api/v1/stats/breakdown?by=user&period=today`, { token: wangToken })
const statsRows = (stats.body as { rows: { key: string }[] }).rows ?? []
check('★★ 新 token 也能打开看板并看到自己的用量', stats.status === 200 && statsRows.some((r) => r.key === '王五'), JSON.stringify(statsRows))

// ★ 人员筛选走的是**前端拼出来的查询串**（`URLSearchParams` 会把逗号编码成 %2C），
//   这里用同样的方式拼一次，确认多选筛选在真实 HTTP 上成立。
const multiQuery = new URLSearchParams({
  by: 'user',
  period: 'today',
  user: `王五,${'unknown'}`,
})
const multi = await call(`${base}/api/v1/stats/breakdown?${multiQuery.toString()}`, {
  token: wangToken,
})
const multiRows = (multi.body as { rows: { key: string }[] }).rows ?? []
check(
  '★ 人员多选（逗号分隔，URL 编码后）只返回选中的人',
  multi.status === 200 && multiRows.length === 1 && multiRows[0]?.key === '王五',
  JSON.stringify(multiRows),
)

// ── 6. 业务失败是 200 + ok:false ────────────────────────────────────────────
console.log('\n【6】业务失败：200 + ok:false（要改的是输入）')
const dup = await call(members, { method: 'POST', token: ENV_ADMIN_TOKEN, body: { name: '张三' } })
check('重名 → 200 + ok:false', dup.status === 200 && dup.body?.ok === false, JSON.stringify(dup.body))
check('原因说清同名会并成一个人', String(dup.body?.reason).includes('同名'))

const reserved = await call(members, { method: 'POST', token: ENV_ADMIN_TOKEN, body: { name: 'unknown' } })
check('姓名 unknown（未归属保留键）被拒', reserved.body?.ok === false)

const badShape = await call(members, { method: 'POST', token: ENV_ADMIN_TOKEN, body: {} })
check('请求形状不对 → 400', badShape.status === 400, String(badShape.status))

// ── 7. 重置 / 吊销 ──────────────────────────────────────────────────────────
console.log('\n【7】重置与吊销')
const rotated = await call(`${members}/rotate`, { method: 'POST', token: ENV_ADMIN_TOKEN, body: { token: wangToken } })
const newWangToken = (rotated.body as AdminMemberResponse).member?.token ?? ''
check('重置返回新 token', rotated.status === 200 && newWangToken !== wangToken, JSON.stringify(rotated.body))

const oldAfterRotate = await call(`${base}/api/v1/stats/overview?period=today`, { token: wangToken })
check('★ 旧 token 立刻失效（看板 401）', oldAfterRotate.status === 401, String(oldAfterRotate.status))
const newAfterRotate = await call(`${base}/api/v1/stats/overview?period=today`, { token: newWangToken })
check('新 token 可用', newAfterRotate.status === 200, String(newAfterRotate.status))

const renamed = await call(`${members}/update`, {
  method: 'POST',
  token: ENV_ADMIN_TOKEN,
  body: { token: newWangToken, name: '王五（研发二部）', dept: '研发二部' },
})
check('改名成功且 token 不变', (renamed.body as AdminMemberResponse).member?.token === newWangToken)
check('改名落到文件', readFileSync(credPath, 'utf8').includes('王五（研发二部）'))

const revoked = await call(`${members}/revoke`, { method: 'POST', token: ENV_ADMIN_TOKEN, body: { token: newWangToken } })
check('吊销成功', revoked.status === 200 && (revoked.body as AdminMemberResponse).ok === true)
const afterRevoke = await call(`${base}/api/v1/stats/overview?period=today`, { token: newWangToken })
check('★ 吊销后看板 401', afterRevoke.status === 401, String(afterRevoke.status))
check('吊销后文件里也没有他了', !readFileSync(credPath, 'utf8').includes('王五'))

// ── 8. 环境变量管理员不可在页面上维护 ──────────────────────────────────────
console.log('\n【8】环境变量注入的管理员只能在部署侧改')
const revokeEnv = await call(`${members}/revoke`, { method: 'POST', token: ENV_ADMIN_TOKEN, body: { token: ENV_ADMIN_TOKEN } })
check('删除被拒（200 + ok:false）', revokeEnv.status === 200 && revokeEnv.body?.ok === false)
check('原因指向 ATR_ADMIN_TOKEN', String(revokeEnv.body?.reason).includes('ATR_ADMIN_TOKEN'))

// ── 9. 路由分发与 404/405 ───────────────────────────────────────────────────
console.log('\n【9】路由分发')
const wrongMethod = await call(`${members}/rotate`, { token: ENV_ADMIN_TOKEN })
check('GET 子动作 → 405', wrongMethod.status === 405, String(wrongMethod.status))
check('405 带 Allow: POST', wrongMethod.headers.get('allow') === 'POST', String(wrongMethod.headers.get('allow')))
const getMembersPost = await call(`${members}/nope`, { method: 'POST', token: ENV_ADMIN_TOKEN, body: { token: 'x' } })
check('未知子路径 → 404', getMembersPost.status === 404, String(getMembersPost.status))
const issueOnSub = await call(`${members}/issue`, { method: 'POST', token: ENV_ADMIN_TOKEN, body: { name: '甲' } })
check('签发挂在 /members 而不是 /members/issue → 404 且给出指引', issueOnSub.status === 404 && String(issueOnSub.body?.reason).includes('POST /api/v1/admin/members'))

// ── 10. 第二个服务：只有文件里的一个管理员 → 最后一个管理员护栏 ────────────
console.log('\n【10】没有环境变量管理员时的「最后一个管理员」护栏')
const home2 = mkdtempSync(join(tmpdir(), 'atr-e2e-admin2-'))
mkdirSync(join(home2, 'token-report'), { recursive: true })
const credPath2 = join(home2, 'token-report', 'credentials.json')
writeFileSync(credPath2, JSON.stringify([{ token: BOSS_TOKEN, name: '李经理', role: 'admin' }]), 'utf8')

const solo = await createServer({
  port: PORT + 1,
  host: '127.0.0.1',
  dshHome: home2,
  dbPath: join(home2, 'token-report', 'portal.sqlite'),
  credentialsPath: credPath2,
  enableLocalApi: false,
})
const soloHealth = (await (await fetch(`${solo.url}/api/health`)).json()) as { adminCount: number }
check('该服务只有 1 个管理员', soloHealth.adminCount === 1)

const dropLastAdmin = await call(`${solo.url}/api/v1/admin/members/revoke`, {
  method: 'POST',
  token: BOSS_TOKEN,
  body: { token: BOSS_TOKEN },
})
check('★ 删最后一个管理员被拒', dropLastAdmin.status === 200 && dropLastAdmin.body?.ok === false, JSON.stringify(dropLastAdmin.body))
check('原因说清后果（没人能再发 token）', String(dropLastAdmin.body?.reason).includes('最后一个管理员'))
check('文件没被动过', JSON.parse(readFileSync(credPath2, 'utf8')).length === 1)

const demoteLastAdmin = await call(`${solo.url}/api/v1/admin/members/update`, {
  method: 'POST',
  token: BOSS_TOKEN,
  body: { token: BOSS_TOKEN, role: 'member' },
})
check('★ 降级最后一个管理员同样被拒', demoteLastAdmin.body?.ok === false)
await solo.stop()

// ── 11. 第三个服务：凭证文件读不懂 → 拒绝写入，且服务照常起 ────────────────
console.log('\n【11】凭证文件损坏时：服务能起，但拒绝一切写入')
const home3 = mkdtempSync(join(tmpdir(), 'atr-e2e-admin3-'))
mkdirSync(join(home3, 'token-report'), { recursive: true })
const credPath3 = join(home3, 'token-report', 'credentials.json')
const broken = '[ { "token": "atr-x", "name": "甲" },, ]'
writeFileSync(credPath3, broken, 'utf8')

const damaged = await createServer({
  port: PORT + 2,
  host: '127.0.0.1',
  dshHome: home3,
  dbPath: join(home3, 'token-report', 'portal.sqlite'),
  credentialsPath: credPath3,
  adminToken: ENV_ADMIN_TOKEN,
  enableLocalApi: false,
})
// 凭证文件坏了，但环境变量管理员还在 —— 这是「文件坏了怎么救」的唯一入口
const damagedList = await call(`${damaged.url}/api/v1/admin/members`, { token: ENV_ADMIN_TOKEN })
const damagedBody = damagedList.body as AdminMembersResponse
check('服务照常启动，仍能进管理页', damagedList.status === 200, String(damagedList.status))
check('页面看到「不可写」与原因', damagedBody.writable === false && String(damagedBody.writeBlockedReason).includes('无法解析'))
const damagedIssue = await call(`${damaged.url}/api/v1/admin/members`, {
  method: 'POST',
  token: ENV_ADMIN_TOKEN,
  body: { name: '乙' },
})
check('★ 签发被拒（不拿空表覆盖唯一真值）', damagedIssue.body?.ok === false && String(damagedIssue.body?.reason).includes('拒绝写入'))
check('★ 原文件一个字节都没动', readFileSync(credPath3, 'utf8') === broken)
await damaged.stop()

// ── 清理 ────────────────────────────────────────────────────────────────────
await portal.stop()
rmSync(home, { recursive: true, force: true })
rmSync(home2, { recursive: true, force: true })
rmSync(home3, { recursive: true, force: true })

console.log(`\n${'─'.repeat(50)}`)
console.log(`结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed > 0 ? 1 : 0)