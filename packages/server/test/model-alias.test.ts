/**
 * v12「供应商 / 模型归一化」的 HTTP 端到端断言 —— **不起监听**。
 *
 * ## 为什么单独一个文件，而不是塞进 `e2e-admin.ts`
 *
 * `e2e-admin.ts` 是「一条脚本从头跑到尾」的形态：它的断言彼此共享一份不断演进的
 * 规则表（供应商 → 项目 → 单价依次叠加），所以任何一段的改动都会扰动后面所有段的
 * 前置状态。归一化这条链路的断言要钉的东西（折叠哪些维度、`*` 怎么展开、明细给不给原值）
 * 与那份脚本里其它部分毫无关系，混在一起只会让「这一条红了到底是谁弄的」变得难答。
 *
 * 这里用 `createHandlerFor()` + `new Request(...)`（与 `http-contract.test.ts` 同一套做法）：
 * 不占端口、不参与端口重试、可以和 `bun test` 全仓并发跑。
 * 真套接字那一层（`idleTimeout` / 端口自增）仍由 `e2e-admin.ts` 覆盖 —— 两者互补。
 *
 * ## 这份测试要钉住的五件事
 *
 * 1. **一条规则只折叠一个维度**：供应商规则只改 `provider`，模型规则只改 `model`，
 *    组合维度 `provider-model` **两段各折叠各的**（更深的 `source-provider-model`
 *    不在看板的分发面上，由核心层用例覆盖）。
 * 2. **模型规则的两档粒度**：`provider = '*'` 表示任意供应商；填真实供应商名则只在那家内匹配，
 *    且**限定供应商优先于通配**（`CASE` 的分支顺序即语义）。
 * 3. **明细同时给出归一化名与原值** —— 那是人核对「规则配得对不对」的唯一地方，
 *    而模型原值**同时是计价用的键**。
 * 4. **事实表里的 `provider` / `model` 一个字节都没被改写**（归一化只作用在查询表达式上）。
 * 5. **服务端的跨字段互锁**：`model` 为空时 `provider` 不能是 `'*'`
 *    —— 那是一条永远匹配不到任何用量的规则，而它在列表里看起来完全正常。
 *
 * ⚠️ **凭证的选择**：`admin/members/tokens` 签出的是普通上报凭证，权限是
 *   `DEFAULT_SCOPES`（`identity:read` + `usage:write`）—— 拿它查看板会 403。
 *   本文件要「既能上报、又能读看板」，所以一律用 `admin/members/appkey`
 *   （`APP_KEY_SCOPES` = `usage:write` + `stats:read`）。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openPortalStore } from '@ai-token-report/core/db'
import { createHandlerFor, type HandlerBundle } from '../src/index.js'
import { seedDatabaseIdentity } from './database-fixture.js'

// ── 请求小工具 ────────────────────────────────────────────────────
// ⚠️ `call` / `mutate` 必须是**函数声明**（提升）或在使用前定义：下文在模块顶层
//   就要用它签发夹具凭证，而 `const` 箭头函数在模块求值时还处在 TDZ 里。
const BASE = 'http://127.0.0.1:8787'

async function call(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await bundle.handler(new Request(BASE + path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const text = await res.text()
  let parsed: any = null
  try { parsed = JSON.parse(text) } catch { parsed = null }
  return { status: res.status, body: parsed }
}
const mutate = (method: string, path: string, headers: Record<string, string>, body: unknown) =>
  call(method, path, headers, body)

// ── 夹具：一次性临时 home + 隔离上报库 ────────────────────────────
const roots: string[] = []
afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const home = mkdtempSync(join(tmpdir(), 'atr-model-alias-'))
roots.push(home)
/** 数据目录**显式指定**：缺省值在家目录下（`~/.ai-token-report`），不指会去开真实的上报库。 */
const dataDir = join(home, 'token-report')
mkdirSync(dataDir, { recursive: true })
const dbPath = join(dataDir, 'portal.sqlite')

const ADMIN_TOKEN = 'atr-model-alias-admin-0001'
await seedDatabaseIdentity({ sqlitePath: dbPath }, [{ token: ADMIN_TOKEN, name: '归一化管理员', role: 'admin' }])

const bundle: HandlerBundle = await createHandlerFor({
  dshHome: home,
  dataDir,
  dbPath,
  enableLocalApi: false,
  // 关掉访问日志：断言输出本来就够长了。
  requestLog: false,
})

const ADMIN = { Authorization: `Bearer ${ADMIN_TOKEN}` }

// ── 夹具人员与凭证 ────────────────────────────────────────────────
/** 建立一个人员（`role_ids` 是必填）。 */
async function createMember(name: string): Promise<string> {
  const roles = (await call('GET', '/api/v1/admin/roles', ADMIN)).body.roles
  const memberRole = roles.find((role: any) => role.code === 'member')
  expect(memberRole).toBeDefined()
  const created = await mutate('POST', '/api/v1/admin/members', ADMIN, { name, role_ids: [memberRole.role_id] })
  expect(created.status).toBe(200)
  return created.body.member.member_id
}
/** 给某人签一把 appKey（`usage:write` + `stats:read`），返回明文。 */
async function issueAppKey(memberId: string, label: string): Promise<string> {
  const issued = await mutate('POST', '/api/v1/admin/members/appkey', ADMIN, { member_id: memberId, label })
  expect(issued.status).toBe(200)
  return issued.body.token_secret
}

const reporterMember = await createMember('归一化上报人')
const reporter = { Authorization: `Bearer ${await issueAppKey(reporterMember, '归一化上报')}` }

// ── 断言小工具 ────────────────────────────────────────────────────
/** 上报一批事件（每个 `(provider, model)` 一条）。 */
async function ingest(
  records: Array<{ id: string; provider: string; model: string }>,
  headers: Record<string, string> = reporter,
): Promise<number> {
  const result = await mutate('POST', '/api/v1/token-usage', headers, {
    schemaVersion: 1,
    client: {},
    generatedAt: new Date().toISOString(),
    records: records.map(r => ({
      event_id: r.id,
      session_id: 'model-alias',
      seq: 1,
      ts: Date.now(),
      provider: r.provider,
      model: r.model,
      input_tokens: 10,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
    })),
  })
  expect(result.status).toBe(200)
  return result.body.accepted
}

const rows = async (by: string, headers: Record<string, string> = ADMIN): Promise<any[]> => {
  const result = await call('GET', `/api/v1/stats/breakdown?identity_view=member&by=${by}`, headers)
  expect(result.status).toBe(200)
  return result.body.rows
}
const keys = async (by: string, headers: Record<string, string> = ADMIN): Promise<string[]> =>
  (await rows(by, headers)).map(row => row.key)
const recordFor = async (eventId: string, headers: Record<string, string> = ADMIN): Promise<any> => {
  const result = await call('GET', '/api/v1/stats/records?identity_view=member', headers)
  expect(result.status).toBe(200)
  return result.body.rows.find((row: any) => row.eventId === eventId)
}
/** 配一条规则（断言 200）。 */
const setRule = async (input: Record<string, unknown>): Promise<any> => {
  const result = await mutate('POST', '/api/v1/admin/provider-aliases', ADMIN, input)
  expect(result.status).toBe(200)
  return result.body.alias
}
const listAliases = async (): Promise<any[]> => {
  const result = await call('GET', '/api/v1/admin/provider-aliases', ADMIN)
  expect(result.status).toBe(200)
  return result.body.aliases
}
const deleteAliases = async (predicate: (entry: any) => boolean): Promise<void> => {
  for (const entry of (await listAliases()).filter(predicate)) {
    const result = await mutate('POST', '/api/v1/admin/provider-aliases/delete', ADMIN, { alias_id: entry.alias_id })
    expect(result.status).toBe(200)
  }
}

// 四条用量，四个互不相同的 `(provider, model)`：每条用例只动自己那一对，
// 于是它们可以各自建规则、各自清理，互不干扰。
const A = { id: 'ma:1', provider: 'alpha', model: 'mdl-a' }
const B = { id: 'ma:2', provider: 'beta', model: 'mdl-b' }
const C = { id: 'ma:3', provider: 'gamma', model: 'mdl-c' }
const D = { id: 'ma:4', provider: 'delta', model: 'mdl-d' }

describe('供应商 / 模型归一化（HTTP）', () => {
  test('夹具：四条用量，四个原始 (provider, model)', async () => {
    expect(await ingest([A, B, C, D])).toBe(4)
    expect((await keys('provider')).sort()).toEqual(['alpha', 'beta', 'delta', 'gamma'])
    expect((await keys('model')).sort()).toEqual(['mdl-a', 'mdl-b', 'mdl-c', 'mdl-d'])
  })

  test('★ 供应商规则只折叠 provider 那一段，模型名原样保留', async () => {
    await setRule({ scope: 'global', provider: 'alpha', alias: '甲供应商' })
    try {
      expect((await keys('provider')).sort()).toEqual(['beta', 'delta', 'gamma', '甲供应商'])
      // 组合维度（键是 `provider/model`）：只有前半段被换掉。
      const combo = await keys('provider-model')
      expect(combo).toContain('甲供应商/mdl-a')
      expect(combo).not.toContain('alpha/mdl-a')
      expect((await keys('model')).sort()).toEqual(['mdl-a', 'mdl-b', 'mdl-c', 'mdl-d'])
      // 明细里两个字段都在，且该行的模型名**没有**被动过。
      const row = await recordFor(A.id)
      expect(row.provider).toBe('甲供应商')
      expect(row.providerRaw).toBe('alpha')
      expect(row.model).toBe('mdl-a')
      // 与展示名相同时服务端刻意**不发** `modelRaw`（省一个必然相同的字段）。
      expect(row.modelRaw).toBeUndefined()
    } finally {
      await deleteAliases(e => e.provider === 'alpha')
    }
  })

  test('★ 任意供应商的模型规则把两个原始模型名折成一行', async () => {
    await setRule({ scope: 'global', provider: '*', model: 'mdl-a', alias: '统一模型' })
    await setRule({ scope: 'global', provider: '*', model: 'mdl-b', alias: '统一模型' })
    try {
      expect((await keys('model')).sort()).toEqual(['mdl-c', 'mdl-d', '统一模型'])
      // 折叠了名字但**总量不变**：两条记录都在那一组里。
      const folded = (await rows('model')).find(row => row.key === '统一模型')
      expect(folded.calls).toBe(2)
      // 组合维度：两段各折叠各的（此处还没有供应商规则，所以前半段是原值）。
      const combo = await keys('provider-model')
      expect(combo).toContain('alpha/统一模型')
      expect(combo).toContain('beta/统一模型')
      expect(combo).not.toContain('alpha/mdl-a')
      // ⚠️ 更深的 `source-provider-model` 不在**看板**的分发面上（`GROUP_BYS` 里没有它，
      //   请求它是 400 —— 它只服务 CLI 的单表输出）。那一段折叠由核心层
      //   `core/test/provider-alias.test.ts` 的 `source-provider-model` 用例覆盖，
      //   这里刻意不重复断一个请求就会 400 的维度。
      // ★ 明细给出原值：它是计价用的键（`model_price` 按上报原值匹配）。
      const row = await recordFor(A.id)
      expect(row.model).toBe('统一模型')
      expect(row.modelRaw).toBe('mdl-a')
    } finally {
      await deleteAliases(e => e.model === 'mdl-a' || e.model === 'mdl-b')
    }
  })

  test('★ 限定供应商的模型规则优先于通配规则（分支顺序即语义）', async () => {
    // 同一个模型名 `mdl-c`，落在**两个不同的供应商**下 —— 这是本条用例的全部前提：
    // 夹具里 `delta` 报的是 `mdl-d`，所以先补一条 `delta/mdl-c`。
    const E = { id: 'ma:5', provider: 'delta', model: 'mdl-c' }
    expect(await ingest([E])).toBe(1)
    // 一条通配规则 + 一条只对 `delta` 生效的规则。
    await setRule({ scope: 'global', provider: '*', model: 'mdl-c', alias: '通配模型' })
    await setRule({ scope: 'global', provider: 'delta', model: 'mdl-c', alias: 'Delta 专属模型' })
    try {
      // `gamma` 报的 mdl-c 走通配；`delta` 报的同名模型走它自己的规则。
      expect((await recordFor(C.id)).model).toBe('通配模型')
      expect((await recordFor(E.id)).model).toBe('Delta 专属模型')
      // 两者的原值都能在明细里看到（用来解释「为什么这两个不一样」）。
      expect((await recordFor(C.id)).modelRaw).toBe('mdl-c')
      expect((await recordFor(E.id)).modelRaw).toBe('mdl-c')
      // 列表里两条并存，且「任意供应商」那条原样回 `*`。
      const rules = await listAliases()
      expect(rules.filter(e => e.model === 'mdl-c').map(e => e.provider).sort()).toEqual(['*', 'delta'])
    } finally {
      await deleteAliases(e => e.model === 'mdl-c')
    }
  })

  test('★ 供应商规则与模型规则可以落在同一个原始 supplier 上', async () => {
    // v12 把唯一索引换成 `(member_id, provider, model)` 就是为了让这两条能同时存在：
    // 旧的两列索引下它们是**同一个键**，第二条根本写不进去。
    await setRule({ scope: 'global', provider: 'beta', alias: '乙供应商' })
    await setRule({ scope: 'global', provider: 'beta', model: 'mdl-b', alias: '乙的模型' })
    try {
      expect((await listAliases()).filter(e => e.provider === 'beta')).toHaveLength(2)
      // 供应商规则在列表里的 `model` 是 `null`（不是空串）—— 它是「这是一条供应商规则」本身。
      const supplierRule = (await listAliases()).find(e => e.provider === 'beta' && e.model === null)
      expect(supplierRule.alias).toBe('乙供应商')
      // 两条各自生效：供应商那一段与模型那一段分别折叠。
      const combo = await keys('provider-model')
      expect(combo).toContain('乙供应商/乙的模型')
      expect(combo).not.toContain('beta/mdl-b')
    } finally {
      await deleteAliases(e => e.provider === 'beta')
    }
  })

  test('★ 按归一化后的模型名筛选，命中即可；拿原值筛则一条不命中', async () => {
    await setRule({ scope: 'global', provider: '*', model: 'mdl-d', alias: '筛选目标' })
    try {
      expect((await keys('model'))).toContain('筛选目标')
      // ⚠️ 筛选参数名是单数 `model`（`stats-route.ts` 的 `params.get('model')`），
      //   且它匹配的是**归一化后**的表达式 —— 页面展示什么就能筛什么。
      const filter = encodeURIComponent('筛选目标')
      const scoped = await call('GET', `/api/v1/stats/breakdown?identity_view=member&by=model&model=${filter}`, ADMIN)
      expect(scoped.status).toBe(200)
      expect(scoped.body.rows.map((row: any) => row.key)).toEqual(['筛选目标'])
      expect(scoped.body.rows[0].calls).toBe(1)
      // ★ 拿**原值**筛同一个模型名则一条都不命中：归一化后只有一套口径。
      const byRaw = await call('GET', '/api/v1/stats/breakdown?identity_view=member&by=model&model=mdl-d', ADMIN)
      expect(byRaw.status).toBe(200)
      expect(byRaw.body.rows).toEqual([])
    } finally {
      await deleteAliases(e => e.model === 'mdl-d')
    }
  })

  test('★ 服务端互锁：`model` 为空时 `provider` 不能是 `*`', async () => {
    const anyProvider = await mutate('POST', '/api/v1/admin/provider-aliases', ADMIN, { scope: 'global', provider: '*', alias: 'x' })
    expect(anyProvider.status).toBe(400)
    expect(String(anyProvider.body.reason)).toContain('不限定供应商')
    // 空串模型名同样是 400：不然它会落成一条「模型名是空串」的幽灵规则。
    expect((await mutate('POST', '/api/v1/admin/provider-aliases', ADMIN, { scope: 'global', provider: 'delta', model: '', alias: 'x' })).status).toBe(400)
    // 模型名首尾空格会让精确匹配静默不命中，也必须挡住。
    expect((await mutate('POST', '/api/v1/admin/provider-aliases', ADMIN, { scope: 'global', provider: 'delta', model: 'mdl-d ', alias: 'x' })).status).toBe(400)
    // 归一化名不能带 `/`（它是 provider 与 model 的分隔符）——供应商与模型规则共用这道校验。
    expect((await mutate('POST', '/api/v1/admin/provider-aliases', ADMIN, { scope: 'global', provider: 'delta', model: 'mdl-d', alias: 'a/b' })).status).toBe(400)
    // 以上全部被拒 ⇒ 库里一条都没多出来（前面的用例各自清理干净了）。
    expect(await listAliases()).toHaveLength(0)
  })

  test('★ 事实表里的 provider / model 永远是原值', async () => {
    await setRule({ scope: 'global', provider: 'alpha', alias: '甲供应商' })
    await setRule({ scope: 'global', provider: '*', model: 'mdl-d', alias: '甲模型' })
    try {
      // 读一遍看板（走归一化），确认表达式确实动了两段。
      expect((await keys('provider'))).toContain('甲供应商')
      expect((await keys('model'))).toContain('甲模型')
      const store = await openPortalStore({ sqlitePath: dbPath })
      try {
        const providers = await store.all<{ provider: string }>('SELECT DISTINCT provider FROM usage_event ORDER BY provider')
        const models = await store.all<{ model: string }>('SELECT DISTINCT model FROM usage_event ORDER BY model')
        expect(providers.map(r => r.provider)).toEqual(['alpha', 'beta', 'delta', 'gamma'])
        expect(models.map(r => r.model)).toEqual(['mdl-a', 'mdl-b', 'mdl-c', 'mdl-d'])
      } finally { await store.close() }
    } finally {
      await deleteAliases(e => e.provider === 'alpha' || e.model === 'mdl-d')
    }
  })

  test('按人覆盖：人员模型规则只影响这个人的视图', async () => {
    const mineMember = await createMember('看模型的人')
    const mine = { Authorization: `Bearer ${await issueAppKey(mineMember, '看模型')}` }
    expect(await ingest([{ id: 'ma:mine', provider: 'alpha', model: 'mdl-a' }], mine)).toBe(1)
    await setRule({ scope: 'member', member_id: mineMember, provider: '*', model: 'mdl-a', alias: '我看到的模型' })
    try {
      // 这个人自己看：模型名被折成人员规则里的名字。
      const mineRow = await recordFor('ma:mine', mine)
      expect(mineRow.model).toBe('我看到的模型')
      expect(mineRow.modelRaw).toBe('mdl-a')
      // 管理员（只有全局口径）看到的仍是原值 —— 口径按**查看者**解析，不按数据走。
      expect((await recordFor('ma:mine')).model).toBe('mdl-a')
      expect((await recordFor(A.id)).model).toBe('mdl-a')
    } finally {
      await deleteAliases(e => e.model === 'mdl-a')
    }
  })
})
