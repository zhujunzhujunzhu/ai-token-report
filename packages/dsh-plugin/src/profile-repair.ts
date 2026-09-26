/**
 * 0.3.0 安装事故的离线修复：bundle 负责唯一一次 insert，用户层只覆盖配置。
 * 只变换配置数据，不接触身份、日志、数据库或 outbox；冲突配置拒绝猜测。
 */
export const PUBLISHED_PLUGIN = 'dsh-plugin-token-report'
export const WORKSPACE_PLUGIN = '@ai-token-report/dsh-plugin'
const names = new Set([PUBLISHED_PLUGIN, WORKSPACE_PLUGIN])
type Row = Record<string, unknown>

export function repairProfileData(manifest: Row, patches: Row[]): { manifest: Row; patches: Row[] } {
  const next = structuredClone(manifest)
  const dsh = next['dsh'] as Row | undefined
  const profile = dsh?.['profile'] as Row | undefined
  const bundles = profile?.['bundles']
  if (!Array.isArray(bundles) || !bundles.every((b) => typeof b === 'string')) {
    throw new Error('profile 缺少合法的 dsh.profile.bundles，拒绝修改')
  }
  if (!bundles.includes(PUBLISHED_PLUGIN)) throw new Error('请先在此 profile 安装 dsh-plugin-token-report')
  profile!['bundles'] = bundles.filter((b, i) => b !== WORKSPACE_PLUGIN && bundles.indexOf(b) === i)
  // DSH 每次 plugin add 都会重新登记 dependencies 中的 bundle，旧依赖也须退出。
  const dependencies = next['dependencies'] as Row | undefined
  if (dependencies) delete dependencies[WORKSPACE_PLUGIN]
  const overrides: Row[] = []
  function isPlugin(row: Row): boolean {
    if (row['id'] === 'token-report' && row['name'] && !names.has(String(row['name']))) {
      throw new Error('token-report ID 被其它插件占用，拒绝修改')
    }
    if (names.has(String(row['name'])) && row['id'] !== 'token-report') {
      throw new Error('发现其它 ID 的 token-report 实例，需人工确认其配置')
    }
    return row['id'] === 'token-report'
  }
  function removeInserts(rows: Row[]): Row[] {
    return rows.flatMap((row) => {
      if (isPlugin(row)) {
        const { name: _name, ...override } = row
        overrides.push(override)
        return []
      }
      if (row['group'] && Array.isArray(row['config'])) {
        return [{ ...row, config: removeInserts(row['config'] as Row[]) }]
      }
      return [row]
    })
  }
  const repaired = structuredClone(patches).flatMap((patch) => {
    if (Array.isArray(patch['insert'])) {
      const insert = removeInserts(patch['insert'] as Row[])
      return insert.length ? [{ ...patch, insert }] : []
    }
    if (isPlugin(patch)) {
      const { name: _name, ...override } = patch
      overrides.push(override)
      return []
    }
    return [patch]
  })
  // 多份配置若彼此矛盾，自动挑一份会静默改变上报目标或凭证。
  const combined: Row = { id: 'token-report' }
  for (const override of overrides) {
    for (const [key, value] of Object.entries(override)) {
      if (key in combined && JSON.stringify(combined[key]) !== JSON.stringify(value)) {
        throw new Error(`重复挂载的 ${key} 配置冲突，拒绝自动覆盖；请从备份中人工合并`)
      }
      combined[key] = value
    }
  }
  if (Object.keys(combined).length > 1) repaired.push(combined)
  return { manifest: next, patches: repaired }
}

/** 同时检查 ID 与包名，改一个 ID 不能掩盖重复服务注册。 */
export function assertSinglePlugin(entries: Row[]): void {
  const ids = new Set<string>()
  let count = 0
  function visit(rows: Row[]): void {
    for (const row of rows) {
      const id = row['id']
      if (typeof id === 'string') {
        if (ids.has(id)) throw new Error(`duplicate loader entry id: ${id}`)
        ids.add(id)
      }
      if (row['id'] === 'token-report' || names.has(String(row['name']))) count++
      if (row['group'] && Array.isArray(row['config'])) visit(row['config'] as Row[])
    }
  }
  visit(entries)
  if (count !== 1) throw new Error(`token-report 必须且只能挂载一次，当前 ${count} 次`)
}
