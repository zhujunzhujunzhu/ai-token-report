/**
 * 线上项目规则工具的单测（`scripts/online-project-rules-plan.mjs`）。
 *
 * 这里钉的是**四条会静默出错、且页面上看不出来**的规则：
 *
 * 1. **前缀的大小写与尾部分隔符**：匹配是 `startsWith` 式的逐字比较。
 *    大小写被"归一化"掉 → 在区分大小写的文件系统上把两个目录并成一个；
 *    尾部分隔符没归一到**同一侧** → 一条规则永远不命中，而它在页面上完全正确。
 * 2. **读现有规则必须走 HEX**：`mysql --batch` 会把 Windows 路径里的 `\`
 *    转义成 `\\`。直接 `SELECT prefix` 拿回来的值与本文件里的前缀逐字不同，
 *    于是**每一条都被判成「新建」**，第二遍跑就写出一堆重复行。
 * 3. **只与全局规则比**：同一条目录上「我的名字」覆盖「部门的」是两层语义，不是冲突。
 *    把个人规则也算进"已存在"会让一次全局改名被静默跳过。
 * 4. **空的规则目录必须报错**：算出一个"零条规则的成功计划"最危险 ——
 *    运维会以为已经生效，而看板一个字节都没变。
 */
import { expect, test } from 'bun:test'

import {
  EXISTING_RULES_SQL, PROJECT_ALIAS_MAX_LENGTH, PROJECT_PREFIX_MAX_LENGTH,
  decodeHex, formatPlan, isProjectPathRule, normalizeProjectPrefix, parseExistingRules,
  planAgainstExisting, projectAliasNameError, projectPrefixError, readRules, ruleToApiBody,
} from '../../../scripts/online-project-rules-plan.mjs'
import { renderRemoteApplyScript } from '../../../scripts/online-pricing-plan.mjs'

test('前缀归一化：只剥尾部路径分隔符，单独的 / 保留（否则会变成「匹配一切」）', () => {
  expect(normalizeProjectPrefix('D:\\Coding\\x')).toBe('D:\\Coding\\x')
  expect(normalizeProjectPrefix('D:\\Coding\\x\\')).toBe('D:\\Coding\\x')
  expect(normalizeProjectPrefix('/home/x//')).toBe('/home/x')
  expect(normalizeProjectPrefix('/')).toBe('/')
  // ★ 大小写**一个字节都不动**：`D:\a` 与 `d:\a` 是两个前缀。
  expect(normalizeProjectPrefix('d:\\Coding_agent\\x')).toBe('d:\\Coding_agent\\x')
})

test('匹配值校验：空 / 根目录 / 首尾空格 / 超长 / 不可见字符都拒绝；裸盘符 `D:` 也拒绝', () => {
  expect(projectPrefixError('')).not.toBe(null)
  expect(projectPrefixError('   ')).not.toBe(null)
  expect(projectPrefixError('/')).toContain('根目录')
  expect(projectPrefixError('///')).toContain('根目录')
  expect(projectPrefixError(' D:\\a')).not.toBe(null)
  expect(projectPrefixError('D:\\a ')).not.toBe(null)
  expect(projectPrefixError('D:\\a\tb')).not.toBe(null)
  expect(projectPrefixError('D:\\a')) .toBe(null)
  // `D:\` → `D:` 是「D 盘下的东西」，是一个真实边界，不像根那样折成一行。
  expect(projectPrefixError('D:\\')).toBe(null)
  expect(projectPrefixError('D:\\' + 'x'.repeat(PROJECT_PREFIX_MAX_LENGTH))).not.toBe(null)
  // 🚨 裸写 `D:`（不含分隔符 ⇒ 仓库名模式）会匹配该磁盘下的**每一个**目录 ——
  //   `D:` 本身就是 `D:\a\proj` 的第一段，与文件系统根同一种危险，必须拒掉。
  expect(projectPrefixError('D:')).toContain('盘符')
  expect(projectPrefixError('c:')).toContain('盘符')
  // 而仓库名本身是这一档最推荐的写法，必须放行。
  expect(projectPrefixError('suit-g92-parent')).toBe(null)
})

test('归一化名校验：允许中文与 `/`（这正是本功能的目的），但不许空 / 首尾空格 / 超长', () => {
  expect(projectAliasNameError('甬舟G92项目')).toBe(null)
  expect(projectAliasNameError('AI Token 用量平台')).toBe(null)
  expect(projectAliasNameError('客户A/前端')).toBe(null)
  expect(projectAliasNameError('')).not.toBe(null)
  expect(projectAliasNameError(' 甬舟G92项目')).not.toBe(null)
  expect(projectAliasNameError('x'.repeat(PROJECT_ALIAS_MAX_LENGTH + 1))).not.toBe(null)
})

test('规则目录：空 rows / member 作用域 / 同前缀不同名 都必须抛（不许算出一个空计划当成功）', () => {
  expect(() => readRules({ rows: [] })).toThrow()
  expect(() => readRules('不是 JSON')).toThrow()
  expect(() => readRules({ rows: [{ scope: 'member', prefix: 'D:\\a', alias: 'x' }] })).toThrow()
  expect(() => readRules({ rows: [{ scope: 'global', prefix: '', alias: 'x' }] })).toThrow()
  expect(() => readRules({ rows: [{ scope: 'global', prefix: 'D:\\a', alias: '' }] })).toThrow()
  // 同一个前缀写两条、名字不同 —— 后一条会 upsert 掉前一条，静默覆盖。
  expect(() => readRules({ rows: [
    { scope: 'global', prefix: 'D:\\a', alias: '甲' },
    { scope: 'global', prefix: 'D:\\a', alias: '乙' },
  ] })).toThrow()
  // 同一个前缀写两条、名字相同是可以的（归一化后就是同一条），但要留下告警。
  const same = readRules({ rows: [
    { scope: 'global', prefix: 'D:\\a\\', alias: '甲' },
    { scope: 'global', prefix: 'D:\\a', alias: '甲' },
  ] })
  expect(same.rows.length).toBe(2)
  expect(same.warnings.length).toBe(1)
  expect(same.rows[0]!.prefix).toBe('D:\\a')
})

test('请求体：只送 scope / prefix / alias 三个键（schema 是 strictObject，多一个就 400）', () => {
  const body = ruleToApiBody({ scope: 'global', prefix: 'D:\\Coding\\x', alias: '甬舟G92项目' })
  expect(Object.keys(body).sort()).toEqual(['alias', 'prefix', 'scope'])
  // `enabled` 缺省即 true（服务端 setProjectAlias 的 inputEnabled），不需要显式送。
  expect('enabled' in body).toBe(false)
  expect('member_id' in body).toBe(false)
})

const existing = [
  { scope: 'global', memberId: null, prefix: 'D:\\Coding\\suit-g92-parent', alias: '甬舟G92项目', enabled: true },
  { scope: 'global', memberId: null, prefix: 'D:\\Coding\\old-name', alias: '旧名字', enabled: true },
  { scope: 'global', memberId: null, prefix: 'D:\\Coding\\off', alias: '停用的', enabled: false },
  // 个人规则：同前缀、不同名 —— 绝不能影响全局的判定。
  { scope: 'member', memberId: 'aaaabbbb-1111-2222-3333-444455556666', prefix: 'D:\\Coding\\suit-g92-parent', alias: '我自己的叫法', enabled: true },
]

test('计划：新建 / 无变化 / 改名覆盖 / 重新启用 四态', () => {
  const cases = [
    { prefix: 'D:\\Coding\\brand-new', alias: '新项目', want: 'create' },
    { prefix: 'D:\\Coding\\suit-g92-parent', alias: '甬舟G92项目', want: 'same' },
    { prefix: 'D:\\Coding\\old-name', alias: '新名字', want: 'update' },
    // 停用的规则：同名也算 update（要把它重新启用），不能判成 same 而跳过。
    { prefix: 'D:\\Coding\\off', alias: '停用的', want: 'update' },
    // 尾部分隔符不影响判定：库里存的是归一化形态。
    { prefix: 'D:\\Coding\\suit-g92-parent\\', alias: '甬舟G92项目', want: 'same' },
  ]
  const planned = planAgainstExisting(existing, cases.map((c) => ruleToApiBody({ scope: 'global', prefix: c.prefix, alias: c.alias })))
  expect(planned.map((item) => item.action)).toEqual(cases.map((c) => c.want))
  expect(formatPlan(planned)).toContain('无变化')
  expect(formatPlan(planned)).toContain('原名 旧名字')
  expect(formatPlan(planned)).toContain('原来是停用的')
})

test('★ 个人规则不算「已存在」：全局改名必须真的写下去', () => {
  // 线上有同一个前缀的个人规则（名字不同）—— 全局判定仍必须看全局那一条。
  const planned = planAgainstExisting(
    [{ scope: 'member', memberId: 'aaaabbbb-1111-2222-3333-444455556666', prefix: 'D:\\Coding\\mine', alias: '我的', enabled: true }],
    [ruleToApiBody({ scope: 'global', prefix: 'D:\\Coding\\mine', alias: '部门的' })],
  )
  expect(planned[0]!.action).toBe('create')
})

test('🚨 读现有规则必须走 HEX（否则 Windows 前缀会被 --batch 转义，每条都判成新建）', () => {
  // 这条断言是防"顺手简化"的：改回 SELECT prefix 会让幂等性整个失效。
  expect(EXISTING_RULES_SQL).toContain('HEX(prefix)')
  expect(EXISTING_RULES_SQL).toContain('HEX(alias)')
  // HEX 解码：单反斜杠路径逐字还原（这正是 `SELECT prefix` 做不到的）。
  // ⚠️ 传进去的必须是**原始 hex**，不是解码后的值 —— `parseExistingRules` 自己会解，
  //   把 `D:\Coding\…` 当 hex 再解一次会得到空串（`\` `:` 都不是十六进制字符）。
  const hexOf = (value: string) => Buffer.from(value, 'utf8').toString('hex')
  const rows = [['rule-1', 'global', '', hexOf('D:\\Coding\\suit-g92-parent\\suit-g92-frontend'), hexOf('甬舟G92项目'), '1']]
  const parsed = parseExistingRules(rows)
  expect(parsed[0]!.prefix).toBe('D:\\Coding\\suit-g92-parent\\suit-g92-frontend')
  expect(parsed[0]!.alias).toBe('甬舟G92项目')
  expect(parsed[0]!.memberId).toBe(null)
  expect(parsed[0]!.enabled).toBe(true)
  // ★ alias_id 必须带出来：删除端点只收 alias_id，缺了它就只剩「停用」而不能真删。
  expect(parsed[0]!.aliasId).toBe('rule-1')
  // 空 HEX（NULL 列）与字面量 NULL 都要退化成空串，不能抛。
  expect(decodeHex('')).toBe('')
  expect(decodeHex('NULL')).toBe('')
  // member 行要能认出来（`enabled=0` 同理）。
  const member = parseExistingRules([['rule-2', 'member', 'aaaabbbb-1111-2222-3333-444455556666', hexOf('D:\\x'), hexOf('我的'), '0']])
  expect(member[0]!.aliasId).toBe('rule-2')
  expect(member[0]!.scope).toBe('member')
  expect(member[0]!.memberId).toBe('aaaabbbb-1111-2222-3333-444455556666')
  expect(member[0]!.prefix).toBe('D:\\x')
  expect(member[0]!.alias).toBe('我的')
  expect(member[0]!.enabled).toBe(false)
})

test('🚨 远端脚本支持逐行的 method（项目规则删旧规则走 DELETE + {alias_id}）', () => {
  const rendered = renderRemoteApplyScript({
    endpoint: '/api/v1/admin/project-aliases',
    baseUrl: 'http://127.0.0.1:8787',
    username: 'admin',
    password: 'x',
    rows: [{ label: 'D:\\a → 甲', body: { alias_id: 'rule-1' }, method: 'DELETE' }],
  })
  // 逐行独立成败的性质只有一处实现 ⇒ 循环里必须读 row.method
  expect(rendered).toContain("row.method || 'POST'")
  // 模板串里一个反引号都不能有（会被本机抢先求值）
  expect(rendered).not.toContain('${')
})

test('读现有规则的 SQL 必须带 alias_id（删除唯一可用的句柄）', () => {
  expect(EXISTING_RULES_SQL).toContain('alias_id')
  // 仍然走 HEX —— Windows 前缀会被 --batch 转义，不走 HEX 每条都判成新建
  expect(EXISTING_RULES_SQL).toContain('HEX(prefix)')
})

test('模式判定：含分隔符 ⇒ 路径模式；裸目录名 ⇒ 仓库名模式', () => {
  expect(isProjectPathRule('D:\\Coding\\x')).toBe(true)
  expect(isProjectPathRule('D:/Coding/x')).toBe(true)
  expect(isProjectPathRule('/home/x/proj')).toBe(true)
  expect(isProjectPathRule('suit-g92-parent')).toBe(false)
  expect(isProjectPathRule('D:')).toBe(false)
  // ⚠️ 判据必须与 core 的 `isProjectPathRule()` 一致 —— 它的消费者是
  //   `projectPrefixError()` 的裸盘符那条，两边分叉 ⇒ 前端放行、服务端 400。
})

test('仓库名规则进目录：裸名合法，且不与「同前缀不同名」那条重复检查冲突', () => {
  const catalog = readRules({ rows: [
    { scope: 'global', prefix: 'suit-g92-parent', alias: '甬舟G92项目' },
    { scope: 'global', prefix: 'presales-kb-parent', alias: '售前知识库' },
    // 同一项目的第二个仓库名 ⇒ 同一个 alias 下两条不同 prefix，合法
    { scope: 'global', prefix: 'suit-skills-cli', alias: '技能仓库' },
    { scope: 'global', prefix: 'skills-cli', alias: '技能仓库' },
  ] })
  expect(catalog.rows.length).toBe(4)
  // 两条规则的 prefix 归一化后不变（裸名没有尾部分隔符）
  expect(catalog.rows.map((r) => r.prefix)).toEqual(['suit-g92-parent', 'presales-kb-parent', 'suit-skills-cli', 'skills-cli'])
})
