/** 数据库 v4 管理 → 上报 → SQL 对账，真 HTTP、隔离目录、动态端口。 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPortalStore } from '@ai-token-report/core/db'
import { createServer, type ServerHandle } from '../src/index.js'
import { createIsolatedMysql } from '../verify/mysql-isolation.js'

const home = mkdtempSync(join(tmpdir(), 'atr-admin-v4-'))
const dbPath = join(home, 'portal.sqlite')
const isolation = process.argv.includes('--mysql') ? await createIsolatedMysql() : null
const target = { sqlitePath: dbPath, ...(isolation ? { mysqlUrl: isolation.url } : {}) }
const adminToken = 'isolated-admin-secret'
const servers: ServerHandle[] = []
let checks = 0
function equal(actual: unknown, expected: unknown, message: string) { assert.deepEqual(actual, expected, message); checks++ }
async function start(extra: Record<string, unknown> = {}) {
  const server = await createServer({ port: 0, dshHome: home, dbPath, mysqlUrl: isolation?.url ?? '', adminToken, adminName: '验收管理员', requestLog: false, ...extra })
  servers.push(server)
  return server
}
async function request(server: ServerHandle, path: string, token: string | null = adminToken, body?: unknown) {
  const response = await fetch(server.url + '/api/v1/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, data: await response.json() as any }
}
const event = (id: string) => ({ event_id: id, session_id: 'database-v4', seq: 1, ts: Date.now(), provider: 'fixture', model: 'fixture', input_tokens: 11, output_tokens: 2, cache_read_tokens: 70, cache_write_tokens: 3, reasoning_tokens: 1 })
const payload = (id: string) => ({ schemaVersion: 1, client: { userName: '伪造者' }, generatedAt: new Date().toISOString(), records: [event(id)] })

try {
  let a = await start()
  const b = await start({ adminToken: 'must-not-overwrite-existing-admin' })
  equal((await request(b, 'admin/members', 'must-not-overwrite-existing-admin')).status, 401, '环境变量不会覆盖已初始化数据库')
  equal((await request(a, 'admin/members', null)).status, 401, '未认证401')
  equal((await request(a, 'admin/members', 'wrong')).status, 401, '错误身份401')
  const roles = (await request(a, 'admin/roles')).data.roles
  const memberRole = roles.find((role: any) => role.code === 'member').role_id
  assert(roles.every((role: any) => Array.isArray(role.permissions))); checks++
  const dept = (await request(a, 'admin/departments', adminToken, { name: '研发部' })).data.department
  equal((await request(b, 'departments')).data.departments[0].department_id, dept.department_id, '部门立即跨实例可见')
  const create = async () => request(a, 'admin/members', adminToken, { name: '同名成员', role_ids: [memberRole], department_id: dept.department_id })
  let first = (await create()).data.member
  const second = (await create()).data.member
  assert(first.member_id !== second.member_id); checks++
  const firstIssue = await request(a, 'admin/members/tokens', adminToken, { member_id: first.member_id, label: '插件' })
  const firstSecret = firstIssue.data.token_secret
  const firstToken = firstIssue.data.token
  const secondIssue = await request(a, 'admin/members/tokens', adminToken, { member_id: second.member_id, label: 'CLI' })
  equal(firstIssue.status, 200, '签发成功')
  equal((await request(b, 'identity/verify', firstSecret, {})).data.member_id, first.member_id, '新凭证立即跨实例识别稳定ID')
  equal((await request(b, 'admin/members', firstSecret)).status, 403, '普通身份不能查人员')
  equal((await request(b, 'stats/overview?identity_view=member', firstSecret)).status, 403, '新上报scope不能读取看板')
  equal((await request(b, 'token-usage', firstSecret, payload('v4:1'))).data, { accepted: 1, duplicates: 0, rejected: 0 }, '签发即刻可上报')
  equal((await request(a, 'token-usage', secondIssue.data.token_secret, payload('v4:2'))).status, 200, '同名第二人可上报')
  equal((await request(a, 'token-usage', secondIssue.data.token_secret, payload('v4:1'))).data, { accepted: 0, duplicates: 1, rejected: 0 }, '跨凭证重放幂等')
  const ranking = await request(a, 'stats/breakdown?identity_view=member&by=user')
  equal(ranking.status, 200, '稳定身份排行可用')
  equal(ranking.data.rows.length, 2, '同名人员在排行中为两行')
  equal(ranking.data.rows.map((row: any) => row.label), ['同名成员', '同名成员'], '排行标签与ID分开')
  equal(new Set(ranking.data.rows.map((row: any) => row.member_id)).size, 2, '稳定排行ID唯一')
  const selected = await request(a, `stats/overview?identity_view=member&member_id=${first.member_id}`)
  equal([selected.data.calls, selected.data.totalTokens], [1, 86], '按稳定ID精确筛选且四项完整')
  const legacy = await request(a, 'stats/overview')
  equal([legacy.status, legacy.data.code], [409, 'identity_view_required'], '旧姓名视图不能静默合并同名成员')
  const store = await openPortalStore(target)
  try {
    const rows = await store.all<any>('SELECT * FROM usage_event ORDER BY event_id')
    equal(rows.map(row => row.member_id), [first.member_id, second.member_id], '同名人员不合并，首次归属不漂移')
    equal(rows[0].report_token_id, firstToken.token_id, '首次上报凭证ID不可被重放覆盖')
    equal([rows[0].input_tokens, rows[0].output_tokens, rows[0].cache_read_tokens, rows[0].cache_write_tokens], [11, 2, 70, 3], '四列原值一致')
    assert(rows[0].received_at_ms > 0); checks++
  } finally { await store.close() }
  const failedStore = await openPortalStore(target)
  try { await failedStore.exec(isolation
    ? "CREATE TRIGGER fixture_fail_write BEFORE INSERT ON usage_event FOR EACH ROW BEGIN IF NEW.event_id = 'v4:failure' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected write failure'; END IF; END"
    : "CREATE TRIGGER fixture_fail_write BEFORE INSERT ON usage_event WHEN NEW.event_id = 'v4:failure' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END") } finally { await failedStore.close() }
  equal((await request(b, 'token-usage', firstSecret, payload('v4:failure'))).status, 503, '数据库写失败不能伪报duplicates或成功ACK')
  const recoveryStore = await openPortalStore(target)
  try { await recoveryStore.exec('DROP TRIGGER fixture_fail_write') } finally { await recoveryStore.close() }
  equal((await request(b, 'token-usage', firstSecret, payload('v4:failure'))).data.accepted, 1, '恢复后同批仍可重试入库')
  equal((await request(b, 'token-usage', firstSecret, payload('v4:failure'))).data.duplicates, 1, '恢复重放仅计费一次')
  const memberList = await request(b, 'admin/members')
  const tokenList = await request(b, `admin/members/tokens?member_id=${first.member_id}`)
  assert(!JSON.stringify([memberList, tokenList]).includes(firstSecret)); checks++
  assert(!JSON.stringify(memberList).includes('credentialsPath')); checks++
  equal((await request(a, 'admin/members/update', adminToken, { token: firstSecret, name: '非法旧载荷' })).status, 400, '旧token定位载荷明确拒绝')
  const renamed = await request(a, 'admin/members/update', adminToken, { member_id: first.member_id, expected_version: first.version, name: '改名成员' })
  equal(renamed.status, 200, '按ID改名成功')
  first = renamed.data.member
  equal((await request(a, 'admin/members/update', adminToken, { member_id: first.member_id, expected_version: first.version - 1, name: '覆盖' })).status, 409, '旧版本拒绝覆盖')
  equal((await request(b, 'identity/verify', firstSecret, {})).data.name, '改名成员', '当前身份名跨实例更新')
  const detail = await request(a, `stats/records?identity_view=member&member_id=${first.member_id}`)
  equal(detail.data.rows[0].member_id, first.member_id, '明细给出稳定ID')
  equal(detail.data.rows[0].user_name_snapshot, '同名成员', '改名不改接收时快照')
  const rotated = await request(a, 'admin/members/tokens/rotate', adminToken, { member_id: first.member_id, token_id: firstToken.token_id, expected_version: firstToken.version })
  equal(rotated.status, 200, '轮换凭证成功')
  equal((await request(b, 'token-usage', firstSecret, payload('v4:3'))).status, 401, '旧凭证立即失效')
  equal((await request(b, 'token-usage', rotated.data.token_secret, payload('v4:3'))).status, 200, '新凭证立即可用')
  equal((await request(a, 'admin/members/tokens/revoke', adminToken, { member_id: second.member_id, token_id: rotated.data.token.token_id, expected_version: 1 })).status, 404, '不能跨人员操作Token')
  const disabled = await request(a, 'admin/members/status', adminToken, { member_id: first.member_id, expected_version: first.version, status: 'disabled' })
  equal(disabled.status, 200, '停用人员成功')
  equal((await request(b, 'token-usage', rotated.data.token_secret, payload('v4:4'))).status, 401, '停用人员凭证全部失效')
  const restored = await request(a, 'admin/members/status', adminToken, { member_id: first.member_id, expected_version: disabled.data.member.version, status: 'active' })
  equal(restored.status, 200, '恢复人员成功')
  equal((await request(b, 'token-usage', rotated.data.token_secret, payload('v4:4'))).status, 401, '恢复不复活已吊销凭证')
  const self = memberList.data.members.find((member: any) => member.name === '验收管理员')
  equal((await request(a, 'admin/members/roles', adminToken, { member_id: self.member_id, expected_version: self.version, role_ids: [memberRole] })).status, 409, '最后管理入口不能移除')
  equal((await request(a, 'admin/storage')).data, { kind: isolation ? 'mysql' : 'sqlite', schema_version: 4, available: true, initialized: true }, '存储描述不泄露连接凭证')
  equal((await request(a, 'admin/audit?limit=2&offset=0')).data.rows.length, 2, '审计分页')
  equal((await request(a, 'admin/audit?limit=nope')).status, 400, '非法分页不降级全量')
  const mappingId = randomUUID()
  const legacyKey = 'legacy:' + Buffer.from('同名成员').toString('base64url')
  const historicalStore = await openPortalStore(target)
  try {
    await historicalStore.run('INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,user_id,user_name,dept,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens) VALUES ($id,$session,1,$now,$provider,$model,$name,$snapshot,$dept,5,1,7,0)', { $id: 'legacy:1', $session: 'legacy', $now: Date.now(), $provider: 'fixture', $model: 'fixture', $name: '同名成员', $snapshot: '原姓名快照', $dept: '原部门快照' })
    await historicalStore.run('INSERT INTO legacy_attribution_map (mapping_id,legacy_user_id,source_import_ref,created_at_ms) VALUES ($id,$name,$source,$now)', { $id: mappingId, $name: '同名成员', $source: 'fixture-explicit-import', $now: Date.now() })
  } finally { await historicalStore.close() }
  equal((await request(a, 'admin/legacy-attributions')).data.mappings[0].status, 'pending', '历史映射先显式待确认')
  const legacyFilter = 'stats/overview?identity_view=member&legacy_user=' + encodeURIComponent(legacyKey)
  equal((await request(a, legacyFilter)).data.totalTokens, 13, '历史选择器只选择旧子集')
  const confirmation = { mapping_id: mappingId, member_id: first.member_id, expected_status: 'pending', source_import_ref: 'fixture-explicit-import', reason: '隔离夹具核对原始归属' }
  equal((await request(a, 'admin/legacy-attributions/confirm', adminToken, { ...confirmation, source_import_ref: 'wrong' })).status, 409, '确认来源CAS不匹配拒绝')
  equal((await request(a, 'admin/legacy-attributions/confirm', adminToken, confirmation)).data.updated_events, 1, '确认只回填指定历史')
  equal((await request(a, legacyFilter)).data.totalTokens, 13, '确认后收藏的历史选择器不扩大到成员新事件')
  equal((await request(a, `stats/overview?identity_view=member&member_id=${second.member_id}`)).data.calls, 1, '另一个同名人员不受历史映射影响')
  equal((await request(a, 'admin/legacy-attributions/confirm', adminToken, confirmation)).status, 409, '重复确认不静默覆盖')
  equal((await request(a, 'stats/overview?member_id=' + first.member_id)).status, 400, '新筛选不能隐式切换旧视图')
  equal((await request(a, 'stats/overview?identity_view=member&user=同名成员')).status, 400, '旧筛选不能混入新视图')
  equal((await request(a, 'stats/overview?identity_view=member&legacy_user=legacy:_w')).status, 400, '损坏UTF8历史键拒绝')
  await a.stop()
  a = await start()
  equal((await request(a, 'identity/verify', secondIssue.data.token_secret, {})).data.member_id, second.member_id, '重启后凭证仍有效')
  writeFileSync(join(home, 'credentials.json'), 'broken obsolete file')
  equal((await request(a, 'admin/members')).status, 200, '旧文件不能改变已初始化数据库')
  const empty = await createServer({ port: 0, dshHome: home, dbPath: join(home, 'empty.sqlite'), mysqlUrl: '', adminToken: '', adminUsername: '', adminPassword: '', requestLog: false })
  servers.push(empty)
  equal((await request(empty, 'token-usage', firstSecret, payload('v4:5'))).status, 503, '未初始化上报非2xx')
  equal((await request(empty, 'admin/members')).status, 503, '未初始化管理503')
  console.log(`${typeof Bun === 'undefined' ? 'Node' : 'Bun'} + ${isolation ? 'MySQL' : 'SQLite'} 数据库 v4 真 HTTP 管理与上报通过：${checks} 项`)
} finally {
  await Promise.all(servers.map(server => server.stop().catch(() => {})))
  await isolation?.dispose()
  rmSync(home, { recursive: true, force: true })
}
