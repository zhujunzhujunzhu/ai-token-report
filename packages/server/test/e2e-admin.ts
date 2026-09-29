/** 数据库 v5 管理 → 上报 → SQL 对账，真 HTTP、隔离目录、动态端口。 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPortalStore, PORTAL_SCHEMA_VERSION } from '@ai-token-report/core/db'
import { createServer, type ServerHandle } from '../src/index.js'
import { createIsolatedMysql } from '../verify/mysql-isolation.js'

const home = mkdtempSync(join(tmpdir(), 'atr-admin-v5-'))
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
const event = (id: string) => ({ event_id: id, session_id: 'database-v5', seq: 1, ts: Date.now(), provider: 'fixture', model: 'fixture', input_tokens: 11, output_tokens: 2, cache_read_tokens: 70, cache_write_tokens: 3, reasoning_tokens: 1 })
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
  const group = (await request(a, 'admin/groups', adminToken, { name: '研发组' })).data.group
  equal((await request(b, 'groups')).data.groups[0].group_id, group.group_id, '分组立即跨实例可见')
  const create = async () => request(a, 'admin/members', adminToken, { name: '同名成员', role_ids: [memberRole], group_ids: [group.group_id] })
  // ★ 人员与分组是**多对多**（v5 的核心变化）：一个人可以同时属于两个分组。
  //   两次更新顺带钉住 `group_ids` 是**全量替换**语义 —— 给了列表，结果就是那个列表，
  //   而不是「追加」（追加与「没给全」在请求体里长得一模一样，无法区分）。
  const secondGroup = (await request(a, 'admin/groups', adminToken, { name: '平台组' })).data.group
  const twoGroups = (await request(a, 'admin/members', adminToken, { name: '双组的人', role_ids: [memberRole], group_ids: [group.group_id, secondGroup.group_id] })).data.member
  equal(twoGroups.groups.map((item: any) => item.name).sort(), ['研发组', '平台组'].sort(), '一个人可以同时属于两个分组')
  const shrunk = (await request(a, 'admin/members/update', adminToken, { member_id: twoGroups.member_id, expected_version: twoGroups.version, group_ids: [secondGroup.group_id] })).data.member
  equal(shrunk.groups.map((item: any) => item.name), ['平台组'], 'group_ids 是全量替换：给出的列表就是结果全集')
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
  equal((await request(b, 'token-usage', firstSecret, payload('v5:1'))).data, { accepted: 1, duplicates: 0, rejected: 0 }, '签发即刻可上报')
  equal((await request(a, 'token-usage', secondIssue.data.token_secret, payload('v5:2'))).status, 200, '同名第二人可上报')
  equal((await request(a, 'token-usage', secondIssue.data.token_secret, payload('v5:1'))).data, { accepted: 0, duplicates: 1, rejected: 0 }, '跨凭证重放幂等')
  const ranking = await request(a, 'stats/breakdown?identity_view=member&by=user')
  equal(ranking.status, 200, '稳定身份排行可用')
  equal(ranking.data.rows.length, 2, '同名人员在排行中为两行')
  equal(ranking.data.rows.map((row: any) => row.label), ['同名成员', '同名成员'], '排行标签与ID分开')
  equal(new Set(ranking.data.rows.map((row: any) => row.member_id)).size, 2, '稳定排行ID唯一')
  // ★ 人员排行带出该人所属的**分组名**（多对多 → 数组，不是单值）
  equal(ranking.data.rows.map((row: any) => row.group_names), [['研发组'], ['研发组']], '排行行按人员关系带出分组名')
  const selected = await request(a, `stats/overview?identity_view=member&member_id=${first.member_id}`)
  equal([selected.data.calls, selected.data.totalTokens], [1, 86], '按稳定ID精确筛选且四项完整')
  // ★ 分组维度：一条事件计入它的人员所属的**每个**分组（OR 展开），
  //   所以「各分组之和 ≥ 总量」是定义而不是重复计费；没有事件的分组不进排行。
  const byGroup = await request(a, 'stats/breakdown?identity_view=member&by=group')
  equal(byGroup.status, 200, '分组维度排行可用')
  // ⚠️ 分组维度的行**只给稳定 `key`（group_id）**，不给 `label`：
  //   名字由页面拿 `/api/v1/stats/groups` 的候选目录翻译（`groupLabelOf`），
  //   这样改个分组名不需要服务端在任何一处缓存旧名。
  equal(byGroup.data.rows.map((row: any) => row.key), [group.group_id], '分组行的 key 是稳定 group_id')
  equal([byGroup.data.rows[0].calls, byGroup.data.rows[0].totalTokens], [2, 172], '分组行的数字 = 该分组所有成员的事件之和')
  const oneGroup = await request(a, `stats/overview?identity_view=member&group_id=${group.group_id}`)
  equal([oneGroup.data.calls, oneGroup.data.totalTokens], [2, 172], '按分组筛选 = 该分组所有成员的事件之和')
  const manyGroups = await request(a, `stats/overview?identity_view=member&group_id=${group.group_id},${secondGroup.group_id}`)
  equal(manyGroups.data.calls, 2, 'group_id 支持逗号分隔多选（页面多选框发的就是这种）')
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
    ? "CREATE TRIGGER fixture_fail_write BEFORE INSERT ON usage_event FOR EACH ROW BEGIN IF NEW.event_id = 'v5:failure' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected write failure'; END IF; END"
    : "CREATE TRIGGER fixture_fail_write BEFORE INSERT ON usage_event WHEN NEW.event_id = 'v5:failure' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END") } finally { await failedStore.close() }
  equal((await request(b, 'token-usage', firstSecret, payload('v5:failure'))).status, 503, '数据库写失败不能伪报duplicates或成功ACK')
  const recoveryStore = await openPortalStore(target)
  try { await recoveryStore.exec('DROP TRIGGER fixture_fail_write') } finally { await recoveryStore.close() }
  equal((await request(b, 'token-usage', firstSecret, payload('v5:failure'))).data.accepted, 1, '恢复后同批仍可重试入库')
  equal((await request(b, 'token-usage', firstSecret, payload('v5:failure'))).data.duplicates, 1, '恢复重放仅计费一次')
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
  equal((await request(b, 'token-usage', firstSecret, payload('v5:3'))).status, 401, '旧凭证立即失效')
  equal((await request(b, 'token-usage', rotated.data.token_secret, payload('v5:3'))).status, 200, '新凭证立即可用')
  equal((await request(a, 'admin/members/tokens/revoke', adminToken, { member_id: second.member_id, token_id: rotated.data.token.token_id, expected_version: 1 })).status, 404, '不能跨人员操作Token')
  const disabled = await request(a, 'admin/members/status', adminToken, { member_id: first.member_id, expected_version: first.version, status: 'disabled' })
  equal(disabled.status, 200, '停用人员成功')
  equal((await request(b, 'token-usage', rotated.data.token_secret, payload('v5:4'))).status, 401, '停用人员凭证全部失效')
  const restored = await request(a, 'admin/members/status', adminToken, { member_id: first.member_id, expected_version: disabled.data.member.version, status: 'active' })
  equal(restored.status, 200, '恢复人员成功')
  equal((await request(b, 'token-usage', rotated.data.token_secret, payload('v5:4'))).status, 401, '恢复不复活已吊销凭证')
  const self = memberList.data.members.find((member: any) => member.name === '验收管理员')
  equal((await request(a, 'admin/members/roles', adminToken, { member_id: self.member_id, expected_version: self.version, role_ids: [memberRole] })).status, 409, '最后管理入口不能移除')
  equal((await request(a, 'admin/storage')).data, { kind: isolation ? 'mysql' : 'sqlite', schema_version: PORTAL_SCHEMA_VERSION, available: true, initialized: true }, '存储描述不泄露连接凭证')
  equal((await request(a, 'admin/audit?limit=2&offset=0')).data.rows.length, 2, '审计分页')
  equal((await request(a, 'admin/audit?limit=nope')).status, 400, '非法分页不降级全量')
  const mappingId = randomUUID()
  const legacyKey = 'legacy:' + Buffer.from('同名成员').toString('base64url')
  const historicalStore = await openPortalStore(target)
  try {
    await historicalStore.run('INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,user_id,user_name,group_name,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens) VALUES ($id,$session,1,$now,$provider,$model,$name,$snapshot,$group,5,1,7,0)', { $id: 'legacy:1', $session: 'legacy', $now: Date.now(), $provider: 'fixture', $model: 'fixture', $name: '同名成员', $snapshot: '原姓名快照', $group: '原分组快照' })
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
  // ── ★ appKey：插件面板只填 baseUrl + appKey，权限只有「上报 + 获取统计」 ──
  const appKeyMember = (await request(a, 'admin/members', adminToken, { name: 'appKey 成员', role_ids: [memberRole], group_ids: [group.group_id] })).data.member
  const appKeyIssue = await request(a, 'admin/members/appkey', adminToken, { member_id: appKeyMember.member_id })
  equal(appKeyIssue.status, 200, 'appKey 发放成功')
  equal(appKeyIssue.data.token.scopes, ['stats:read', 'usage:write'], 'appKey 权限恰好是上报与取数两项')
  equal(appKeyIssue.data.token.label, '上报 appKey', 'appKey 有固定的用途标签')
  equal((await request(a, 'admin/members/appkey', adminToken, { member_id: appKeyMember.member_id, scopes: ['members:manage'] })).status, 400, 'appKey 不接受更宽的权限范围')
  const appKeySecret = appKeyIssue.data.token_secret
  const appKeyIdentity = (await request(b, 'identity/verify', appKeySecret, {})).data
  equal([appKeyIdentity.ok, appKeyIdentity.name, appKeyIdentity.member_id, appKeyIdentity.role],
    [true, 'appKey 成员', appKeyMember.member_id, 'member'], '插件只填 appKey 也能拿到服务端署名')
  equal((await request(b, 'token-usage', appKeySecret, payload('v5:appkey'))).data, { accepted: 1, duplicates: 0, rejected: 0 }, 'appKey 可上报')
  equal((await request(b, 'stats/overview?identity_view=member')).status, 200, 'appKey 可获取统计信息')
  equal((await request(b, 'admin/members', appKeySecret)).status, 403, 'appKey 不能进管理面')
  equal((await request(b, `admin/members/tokens?member_id=${appKeyMember.member_id}`, appKeySecret)).status, 403, 'appKey 不能查看或签发凭证')
  // ── ★ appKey 列表：页面的主体，一行一把凭证并带出它发给了谁 ──
  const appKeyList = await request(a, 'admin/appkeys')
  equal(appKeyList.status, 200, 'appKey 列表可读')
  const listed = appKeyList.data.appkeys.find((entry: any) => entry.token.token_id === appKeyIssue.data.token.token_id)
  equal([listed.member.member_id, listed.member.name, listed.member.groups.map((item: any) => item.name)], [appKeyMember.member_id, 'appKey 成员', ['研发组']], '列表按人员关系带出归属与分组')
  equal(listed.token.scopes, ['stats:read', 'usage:write'], '列表带出固定两项权限')
  assert(!JSON.stringify(appKeyList).includes(appKeySecret)); checks++
  equal((await request(a, 'admin/appkeys', null)).status, 401, '未认证不能读凭证列表')
  equal((await request(b, 'admin/appkeys', appKeySecret)).status, 403, 'appKey 不能读凭证列表')
  // ── ★ 角色定义：可新建、可改权限、可停用；内置角色只读；授予不得超权 ──
  const catalog = await request(a, 'admin/roles')
  equal(catalog.data.roles.filter((role: any) => role.is_builtin).map((role: any) => role.code).sort(), ['admin', 'member'], '目录标出两个内置角色')
  equal(catalog.data.roles.every((role: any) => ['active', 'disabled'].includes(role.status)), true, '角色带启停状态')
  equal(catalog.data.permissions.some((permission: any) => permission.code === 'roles:assign'), true, '权限目录随角色目录下发')
  const memberRoleDef = catalog.data.roles.find((role: any) => role.code === 'member')
  const custom = (await request(a, 'admin/roles', adminToken, { code: 'ops-viewer', name: '运营查看者', permission_codes: ['members:read'] })).data.role
  equal([custom.status, custom.is_builtin, custom.permissions], ['active', false, ['members:read']], '新角色默认启用且非内置')
  equal((await request(b, 'admin/roles')).data.roles.some((role: any) => role.role_id === custom.role_id), true, '新角色跨实例立即可见')
  equal((await request(a, 'admin/roles', adminToken, { code: 'ops-viewer', name: '重名', permission_codes: [] })).status, 409, '角色标识唯一')
  equal((await request(a, 'admin/roles', adminToken, { code: '运营角色', name: '中文标识', permission_codes: [] })).status, 400, '角色标识格式明确拒绝')
  equal((await request(a, 'admin/roles/update', adminToken, { role_id: custom.role_id, expected_version: custom.version + 5, name: '过期表单' })).status, 409, '旧版本不能覆盖角色')
  const retuned = await request(a, 'admin/roles/update', adminToken, { role_id: custom.role_id, expected_version: custom.version, name: '运营查看者（新）', permission_codes: ['stats:read', 'members:read'] })
  equal([retuned.status, retuned.data.role.permissions], [200, ['members:read', 'stats:read']], '权限整组替换')
  equal((await request(a, 'admin/roles/update', adminToken, { role_id: custom.role_id, expected_version: retuned.data.role.version, permission_codes: ['nope:read'] })).status, 400, '未知权限码明确拒绝')
  equal((await request(a, 'admin/roles/update', adminToken, { role_id: memberRoleDef.role_id, expected_version: memberRoleDef.version, name: '改名' })).status, 409, '内置角色不能改名')
  equal((await request(a, 'admin/roles/status', adminToken, { role_id: memberRoleDef.role_id, expected_version: memberRoleDef.version, status: 'disabled' })).status, 409, '内置角色不能停用')
  // ★ 一个人同时持多个角色：两个角色各自提供的权限合起来才能授权
  equal((await request(a, 'admin/members/roles', adminToken, { member_id: second.member_id, expected_version: second.version, role_ids: [memberRole, custom.role_id] })).status, 200, '一个人可同时持多个角色')
  const unionToken = await request(a, 'admin/members/tokens', adminToken, { member_id: second.member_id, label: '并集凭证', scopes: ['members:read', 'stats:read'] })
  equal(unionToken.status, 200, '两个角色分别提供的权限可以同时授予')
  equal((await request(b, 'admin/members', unionToken.data.token_secret)).status, 200, '自定义角色真的让这个身份能读人员名单')
  equal((await request(a, 'admin/members/tokens', adminToken, { member_id: second.member_id, label: '越权', scopes: ['audit:read'] })).status, 403, '两个角色都没给的权限仍然授不出')
  equal((await request(a, 'admin/roles/status', adminToken, { role_id: custom.role_id, expected_version: retuned.data.role.version, status: 'disabled' })).status, 409, '仍有人在职持有该角色时不能停用')
  const secondAfter = (await request(a, 'admin/members')).data.members.find((member: any) => member.member_id === second.member_id)
  equal((await request(a, 'admin/members/roles', adminToken, { member_id: second.member_id, expected_version: secondAfter.version, role_ids: [memberRole] })).status, 200, '把角色从人员身上收回')
  equal((await request(a, 'admin/roles/status', adminToken, { role_id: custom.role_id, expected_version: retuned.data.role.version, status: 'disabled' })).data.role.status, 'disabled', '无人持有后可停用')
  equal((await request(a, 'admin/members/roles', adminToken, { member_id: second.member_id, expected_version: secondAfter.version + 1, role_ids: [custom.role_id] })).status, 400, '停用角色不能再分配给人')
  equal((await request(b, 'admin/roles', appKeySecret)).status, 403, 'appKey 不能读角色目录')
  equal((await request(b, 'admin/roles/status', appKeySecret, { role_id: custom.role_id, expected_version: retuned.data.role.version, status: 'active' })).status, 403, 'appKey 不能改角色')
  // ── ★ 有效期：签发可选、事后可改；到期即刻失效；吊销后不能改 ──
  const season = Date.now() + 30 * 24 * 3600 * 1000
  const expiring = (await request(a, 'admin/members/appkey', adminToken, { member_id: appKeyMember.member_id, expires_at_ms: season })).data
  equal(expiring.token.expires_at_ms, season, '签发时可指定有效期')
  equal((await request(a, 'admin/members/appkey', adminToken, { member_id: appKeyMember.member_id, expires_at_ms: Date.now() - 1 })).status, 400, '过去时刻不能作为签发有效期')
  const unlimited = await request(a, 'admin/members/tokens/expiry', adminToken, { member_id: appKeyMember.member_id, token_id: expiring.token.token_id, expected_version: expiring.token.version, expires_at_ms: null })
  equal([unlimited.status, unlimited.data.token.expires_at_ms], [200, null], '可把具体到期时间改回长期有效')
  const dated = await request(a, 'admin/members/tokens/expiry', adminToken, { member_id: appKeyMember.member_id, token_id: expiring.token.token_id, expected_version: unlimited.data.token.version, expires_at_ms: season })
  equal([dated.status, dated.data.token.expires_at_ms], [200, season], '可把长期有效改成具体到期时间')
  equal((await request(a, 'admin/members/tokens/expiry', adminToken, { member_id: appKeyMember.member_id, token_id: expiring.token.token_id, expected_version: unlimited.data.token.version, expires_at_ms: season })).status, 409, '旧版本不能覆盖有效期')
  equal((await request(a, 'admin/members/tokens/expiry', adminToken, { member_id: appKeyMember.member_id, token_id: expiring.token.token_id, expected_version: dated.data.token.version, expires_at_ms: Date.now() - 1 })).status, 400, '过去时刻不能作为有效期')
  equal((await request(a, 'admin/members/tokens/expiry', adminToken, { member_id: appKeyMember.member_id, token_id: expiring.token.token_id, expected_version: dated.data.token.version })).status, 400, '缺 expires_at_ms 明确拒绝而不是当成长期有效')
  equal((await request(b, 'admin/members/tokens/expiry', appKeySecret, { member_id: appKeyMember.member_id, token_id: expiring.token.token_id, expected_version: dated.data.token.version, expires_at_ms: null })).status, 403, 'appKey 不能改有效期')
  equal((await request(a, 'admin/members/tokens/revoke', adminToken, { member_id: appKeyMember.member_id, token_id: expiring.token.token_id, expected_version: dated.data.token.version })).status, 200, '吊销一把待测凭证')
  equal((await request(a, 'admin/members/tokens/expiry', adminToken, { member_id: appKeyMember.member_id, token_id: expiring.token.token_id, expected_version: dated.data.token.version + 1, expires_at_ms: null })).status, 409, '已吊销凭证不能改有效期')
  // ⚠️ 接口刻意不接受过去时刻，而库里还有
  //    `CHECK (expires_at_ms IS NULL OR expires_at_ms > created_at_ms)` ——
  //    直接把到期时间改成过去会被约束拒绝。要让一把 key 变成已过期，只能让它
  //    **签发于更早**，这也正是真实世界里过期的成因（时间往前走，而不是往回改）。
  const expiryStore = await openPortalStore(target)
  try { await expiryStore.run('UPDATE report_tokens SET created_at_ms = $old, expires_at_ms = $ago WHERE token_id = $id', { $old: Date.now() - 2 * 86_400_000, $ago: Date.now() - 86_400_000, $id: appKeyIssue.data.token.token_id }) } finally { await expiryStore.close() }
  equal((await request(b, 'token-usage', appKeySecret, payload('v5:expired'))).status, 401, '到期凭证立即失效')
  const renewed = await request(a, 'admin/members/tokens/expiry', adminToken, { member_id: appKeyMember.member_id, token_id: appKeyIssue.data.token.token_id, expected_version: appKeyIssue.data.token.version, expires_at_ms: season })
  equal([renewed.status, renewed.data.token.expires_at_ms], [200, season], '过期凭证可以续期，不必轮换出一把新的')
  equal((await request(b, 'token-usage', appKeySecret, payload('v5:expired:2'))).data, { accepted: 1, duplicates: 0, rejected: 0 }, '续期后同一把 key 立刻可用')
  const selfTokens = (await request(a, `admin/members/tokens?member_id=${self.member_id}`)).data.tokens
  const selfLongLived = selfTokens.find((token: any) => token.expires_at_ms === null)
  assert(selfLongLived); checks++
  equal((await request(a, 'admin/members/tokens/expiry', adminToken, { member_id: self.member_id, token_id: selfLongLived.token_id, expected_version: selfLongLived.version, expires_at_ms: season })).status, 409, '唯一长期管理凭证不能被改成会过期')
  await a.stop()
  a = await start()
  equal((await request(a, 'identity/verify', secondIssue.data.token_secret, {})).data.member_id, second.member_id, '重启后凭证仍有效')
  writeFileSync(join(home, 'credentials.json'), 'broken obsolete file')
  equal((await request(a, 'admin/members')).status, 200, '旧文件不能改变已初始化数据库')
  const empty = await createServer({ port: 0, dshHome: home, dbPath: join(home, 'empty.sqlite'), mysqlUrl: '', adminToken: '', adminUsername: '', adminPassword: '', requestLog: false })
  servers.push(empty)
  equal((await request(empty, 'token-usage', firstSecret, payload('v5:5'))).status, 503, '未初始化上报非2xx')
  equal((await request(empty, 'admin/members')).status, 503, '未初始化管理503')
  console.log(`${typeof Bun === 'undefined' ? 'Node' : 'Bun'} + ${isolation ? 'MySQL' : 'SQLite'} 数据库 v5 真 HTTP 管理与上报通过：${checks} 项`)
} finally {
  await Promise.all(servers.map(server => server.stop().catch(() => {})))
  await isolation?.dispose()
  rmSync(home, { recursive: true, force: true })
}
