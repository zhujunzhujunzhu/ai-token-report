/** 安装升级必须收敛到一个挂载，同时保留用户配置、其它插件与表达式。 */
import { expect, test } from 'bun:test'
import { assertSinglePlugin, repairProfileData, PUBLISHED_PLUGIN, WORKSPACE_PLUGIN } from '../src/profile-repair.js'

const manifest = { dsh: { profile: { bundles: ['base', WORKSPACE_PLUGIN, PUBLISHED_PLUGIN, PUBLISHED_PLUGIN] } } }
test('旧手动 insert 转为覆盖，两个包/重复 bundle 收敛且保留配置', () => {
  const config = { appKey: { __jsExpr: 'process.env.APP_KEY' }, ui: { position: 'both' } }
  const patches = [{ insert: [{ id: 'other', name: 'other' }, { id: 'token-report', name: WORKSPACE_PLUGIN, config }] }]
  const fixed = repairProfileData(manifest, patches)
  expect(fixed.manifest).toEqual({ dsh: { profile: { bundles: ['base', PUBLISHED_PLUGIN] } } })
  expect(fixed.patches).toEqual([{ insert: [{ id: 'other', name: 'other' }] }, { id: 'token-report', config }])
  expect(repairProfileData(fixed.manifest, fixed.patches)).toEqual(fixed)
  expect(patches[0]!.insert).toHaveLength(2)
})
test('组内重复挂载也会移除，源包名称的覆盖可以继续生效', () => {
  const config = { ui: { position: 'header' } }
  const fixed = repairProfileData(manifest, [{ insert: [{ id: 'group', group: true, config: [{ id: 'token-report', name: WORKSPACE_PLUGIN }] }] }, { id: 'token-report', name: WORKSPACE_PLUGIN, config }])
  expect(fixed.patches.at(-1)).toEqual({ id: 'token-report', config })
})
test('冲突配置与被其它包占用的 ID 不允许自动覆盖', () => {
  expect(() => repairProfileData(manifest, [{ id: 'token-report', config: { appKey: 'a' } }, { id: 'token-report', config: { appKey: 'b' } }])).toThrow('冲突')
  expect(() => repairProfileData(manifest, [{ id: 'token-report', name: 'other' }])).toThrow('占用')
})
test('检查真实合并树时拒绝重复 ID 与改 ID 的第二个实例', () => {
  expect(() => assertSinglePlugin([{ id: 'token-report' }, { id: 'token-report' }])).toThrow('duplicate loader entry')
  expect(() => assertSinglePlugin([{ id: 'token-report' }, { id: 'second', name: PUBLISHED_PLUGIN }])).toThrow('2 次')
  expect(() => assertSinglePlugin([{ id: 'token-report', name: PUBLISHED_PLUGIN }])).not.toThrow()
})
