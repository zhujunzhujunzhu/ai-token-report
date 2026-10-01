/**
 * 部署规则的单测。
 *
 * 这里钉的不是「某个函数返回什么」，而是**四条此前只存在于人脑与一台机器上的规则**：
 *
 * 1. **产物配不配得上这个运行时**：Bun 运行时要求产物里有长口令 TLS 修复，
 *    否则线上 `atr_user`（32 字符口令）会以 `errno 1045` 连不上上报库。
 *    实测 2026-10-01：切换前线上那份 main.mjs 里该标识符命中数为 **0**。
 * 2. **启动包装是仓库里的那一份**：它曾是「只存在于目标机磁盘上」的文件，
 *    谁重建机器就静默退回 Node22，且没有任何地方会报错。
 * 3. **改运行时只改一行**：渲染结果与仓库里那一份的差异必须恰好是 `ATR_RUNTIME_BIN=`。
 *    差的多了，说明渲染器在动别的东西；差的不是这一行，说明它根本没生效。
 * 4. **生成的远端脚本里不许残留 `${`**：模板是 JS 模板字符串拼的，
 *    写 shell 的 `${VAR}` 会被 JS 抢先求值 —— 这正是本次实现时真踩到的坑
 *    （在注释里写了一对反引号，直接把模板字符串截断了）。
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  RUNTIMES, RUNTIME_LINE_PATTERN, START_SCRIPT_REPO_PATH,
  assertBundleSupportsRuntime, renderRemoteScript, renderStartScript, resolveRuntime,
} from '../../../scripts/deploy-plan.mjs'

const repoRoot = resolve(import.meta.dir, '../../..')
const startScriptPath = resolve(repoRoot, START_SCRIPT_REPO_PATH)
const startScriptTemplate = readFileSync(startScriptPath, 'utf8')
const deployServerSource = readFileSync(resolve(repoRoot, 'scripts/deploy-server.mjs'), 'utf8')

/** 生成远端脚本时用的固定参数：内容不重要，重要的是**每次相同**，断言才稳定。 */
const remoteScriptOptions = {
  mode: 'apply', stamp: '2026-01-01T00-00-00-000Z', portalBase: '/ai-token/',
  remoteRoot: '/data/ai-token-report', pm2Name: 'ai-token-server', keepOldAssets: false,
  runtimeName: 'bun', runtimeBin: RUNTIMES.bun.bin,
  startScriptUpload: '/tmp/atr-deploy-2026-01-01T00-00-00-000Z-start.sh',
}

test('运行时名解析：缺省 bun，拼错必须报错而不是回落', () => {
  expect(resolveRuntime('bun').bin).toBe('/usr/local/bin/bun')
  expect(resolveRuntime('node').bin).toBe('/usr/local/node22/bin/node')
  // ⚠️ 拼错成 bunn / Bun / 空串都必须抛：静默回落到某个运行时，
  //    表现是「部署成功但线上跑的不是你要的那个」，而报告里全绿。
  expect(() => resolveRuntime('bunn')).toThrow()
  expect(() => resolveRuntime('Bun')).toThrow()
  expect(() => resolveRuntime('')).toThrow()
})

test('★ renderStartScript 只改 ATR_RUNTIME_BIN 那一行，其余字节原样', () => {
  const rendered = renderStartScript(startScriptTemplate, 'node')
  expect(rendered).toContain(`ATR_RUNTIME_BIN="${RUNTIMES.node.bin}"`)
  expect(rendered).not.toContain(`ATR_RUNTIME_BIN="${RUNTIMES.bun.bin}"`)

  // 逐行 diff：有且只有一行不同，且那一行就是运行时行。
  const before = startScriptTemplate.split('\n')
  const after = rendered.split('\n')
  expect(after.length).toBe(before.length)
  const changed = before.map((line, i) => (line === after[i] ? null : i)).filter((i) => i !== null)
  expect(changed.length).toBe(1)
  expect(before[changed[0]!]).toMatch(RUNTIME_LINE_PATTERN)
})

test('★ 模板少了 ATR_RUNTIME_BIN 行必须报错，绝不静默产出一份没改运行时的脚本', () => {
  // 这正是「改注释而不是改配置」那种失败：渲染"成功"了，线上跑的却还是旧运行时。
  const withoutLine = startScriptTemplate.replace(RUNTIME_LINE_PATTERN, '# 运行时被删掉了')
  expect(() => renderStartScript(withoutLine, 'node')).toThrow(/ATR_RUNTIME_BIN/)
})

test('★ 仓库里的启动包装确实是一份能用的包装（不是样例文本）', () => {
  const lines = startScriptTemplate.split('\n').filter((line) => line.startsWith('ATR_RUNTIME_BIN='))
  expect(lines.length).toBe(1)
  expect(lines[0]).toBe(`ATR_RUNTIME_BIN="${RUNTIMES.bun.bin}"`)
  expect(startScriptTemplate).toContain('. "$ENV_FILE"')
  expect(startScriptTemplate).toContain('/root/.atr/portal.env')
  // ★ 用 exec：pm2 看到的就是真正的服务进程，而不是一个 shell 父进程。
  expect(startScriptTemplate).toContain('exec "$ATR_RUNTIME_BIN"')
  expect(startScriptTemplate).toContain('--static')
  // 🚨 绝不写死项目根：`--remote-root` 一改，写死的路径会指向另一个目录，
  //    而那时 pm2 只会报一句含糊的「找不到模块」。
  //    ⚠️ 只看**非注释行** —— 模板的注释里为了讲清这件事，本身就提到了那个路径。
  const codeLines = startScriptTemplate
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
  expect(codeLines).not.toContain('/data/ai-token-report')
})

test('★ Bun 运行时必须要求产物含长口令 TLS 修复（否则线上 errno 1045）', () => {
  const withFix = 'export function planBunMysqlAuth(url) { /* … */ }'
  const withoutFix = 'export function openMysqlBackend(url) { /* 旧产物 */ }'
  expect(() => assertBundleSupportsRuntime(withFix, 'bun')).not.toThrow()
  expect(() => assertBundleSupportsRuntime(withoutFix, 'bun')).toThrow(/planBunMysqlAuth/)
  // Node 走 mysql2，不受这个上游缺陷影响，因此不设这条前置条件。
  expect(() => assertBundleSupportsRuntime(withoutFix, 'node')).not.toThrow()
})

test('★ 远端脚本：启动包装来自仓库、覆盖前先备份、回滚时一起还原', () => {
  const script = renderRemoteScript(remoteScriptOptions)
  expect(script).toContain('START_SCRIPT=$ROOT/deploy/atr-server-start.sh')
  expect(script).toContain('START_SRC=/tmp/atr-deploy-2026-01-01T00-00-00-000Z-start.sh')
  // 安装前必须备份 —— 这个文件原来只存在于目标机上，丢了没有第二份。
  expect(script).toContain('cp -a "$START_SCRIPT" "$BACKUP/atr-server-start.sh"')
  expect(script).toContain('cp -f "$START_SRC" "$START_SCRIPT"')
  // 回滚要把产物**与启动包装一起**还原：只还原产物会留下「运行时已经换掉了」的半成品。
  expect(script).toMatch(/rollback\(\) \{[\s\S]*cp -a "\$BACKUP\/atr-server-start\.sh"/)
  // 启动包装本身也要过语法检查，否则等于把「服务起不来」推给 pm2。
  expect(script).toContain('bash -n "$START_SRC"')
})

test('★ 远端脚本：健康检查之后要断言进程真的 exec 在指定运行时上', () => {
  const script = renderRemoteScript(remoteScriptOptions)
  expect(script).toContain(`RUNTIME_BIN="${RUNTIMES.bun.bin}"`)
  expect(script).toContain('ATR_DEPLOY_RUNTIME_EXPECTED')
  expect(script).toContain('ATR_DEPLOY_RUNTIME_ACTUAL')
  // 只有两边都读到、且不同才判失败：探测不到（/proc 读不了、进程刚退出）
  // 不能去回滚一个已经健康的部署。
  expect(script).toContain('[ -n "$RUNTIME_EXPECTED" ] && [ -n "$RUNTIME_ACTUAL" ] && [ "$RUNTIME_EXPECTED" != "$RUNTIME_ACTUAL" ]')
  expect(script).toContain('ATR_DEPLOY_RESULT=runtime-mismatch')
})

test('★ 远端脚本：preflight 只上传校验，不碰现网也不装启动包装', () => {
  const script = renderRemoteScript({ ...remoteScriptOptions, mode: 'preflight' })
  const preflightExit = script.indexOf('ATR_DEPLOY_RESULT=preflight-ok')
  expect(preflightExit).toBeGreaterThan(-1)
  // 安装启动包装那一步必须在 preflight 的 exit 之后。
  expect(script.indexOf('cp -f "$START_SRC" "$START_SCRIPT"')).toBeGreaterThan(preflightExit)
  expect(script.indexOf('pm2 restart')).toBeGreaterThan(preflightExit)
})

test('★ 生成的远端脚本里不许残留 shell 的 ${…}（那是 JS 模板字符串的求值语法）', () => {
  const script = renderRemoteScript(remoteScriptOptions)
  // 真踩到过：在模板的注释里写了一对反引号，直接把模板字符串截断成语法错误。
  // `${` 残留说明有人把 shell 的 ${VAR} 写进了 JS 模板 —— 它会被 JS 抢先求值，
  // 轻则变量变空串，重则整个生成的脚本语法错误（而失败点在远端）。
  expect(script).not.toContain('${')
  expect(script).not.toContain('`')
})

test('★ 远端脚本模板只有一份：deploy-server.mjs 不许再自己实现一遍', () => {
  // 两份实现必然漂移，而漂移的那一份正是「生成完就直接在 root 上跑」的脚本。
  expect(deployServerSource).toContain("from './deploy-plan.mjs'")
  expect(deployServerSource).not.toContain('function renderRemoteScript')
  // 上传清单里必须有启动包装，否则远端那句 [ -f "$START_SRC" ] 会直接 fail。
  expect(deployServerSource).toContain('startScriptFile')
})
