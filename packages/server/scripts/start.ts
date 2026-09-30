#!/usr/bin/env bun
/**
 * 服务端启动包装 —— `packages/server` 的 `start` 脚本（根目录的 `bun run server`）。
 *
 * 比 `src/main.ts` 只多做一件事：**启动前先备好本地配置** ——
 * 读 / 生成数据目录下的 `server.env`（见 `src/local/dev-env.ts`），
 * 这样本机自用不必每次手配 `ATR_CAPTCHA_HMAC_KEY` 与管理员初始化值。
 *
 * 三条必须知道的：
 * 1. `src/main.ts` 末尾**无条件**调用 `main()`（导入即启动），所以下面那次 import
 *    就是启动它；环境因此必须在 import **之前**就位（`src/index.ts` 启动时读 `process.env`）。
 * 2. 反过来说：**别给 `main.ts` 加 `import.meta.main` 守卫** ——
 *    Node 22 没有这个属性，`node dist/main.mjs`（pm2 走的就是它）会静默不启动。
 * 3. 生产（pm2 + MySQL）**不走这里**：那份产物入口仍是 `dist/main.mjs`，
 *    环境由 `/root/.atr/portal.env` 提供，本文件一个字节都影响不到它。
 */

import { resolveDataDir } from '@ai-token-report/core'

import { prepareLocalEnv } from '../src/local/dev-env.js'

const argv = process.argv.slice(2)

/** `--data-dir` 得自己认：环境要在 `resolvePaths()` 之前就位。 */
function dataDirFlag(): string | undefined {
  const i = argv.indexOf('--data-dir')
  const value = i >= 0 ? argv[i + 1] : undefined
  return value && !value.startsWith('--') ? value : undefined
}

const result = prepareLocalEnv({ dataDir: dataDirFlag() ?? resolveDataDir(), argv })

if (result.created.length > 0) {
  const out = [
    '',
    '  已生成本地配置（本机 SQLite + 回环监听，未写入仓库任何文件）:',
    `    文件      ${result.path}`,
    `    管理员    ${process.env.ATR_ADMIN_USERNAME ?? ''} / ${process.env.ATR_ADMIN_PASSWORD ?? ''}`,
    '    ⚠ 管理员初始化值只对**空库**首次生效；改过密码后以数据库为准。',
    '    ⚠ 验证码密钥必须所有实例一致：将来改用共享 MySQL / 对外监听时，请显式配置环境变量。',
    '',
  ]
  process.stdout.write(out.join('\n') + '\n')
}

if (result.manualReason) {
  process.stdout.write(
    [
      '',
      `  ⚠ 未自动生成后台登录配置（${result.manualReason}）。`,
      `    缺失: ${result.missing.join(' / ')}`,
      '    共享 / 对外部署请显式配置这些变量，否则后台登录一律返回 503：',
      '      ATR_CAPTCHA_HMAC_KEY=<至少 32 字符，所有实例同一值>',
      '      ATR_ADMIN_USERNAME=<管理员用户名>  ATR_ADMIN_PASSWORD=<12~128 位>（仅空库首次生效）',
      '',
    ].join('\n') + '\n',
  )
}

await import('../src/main.js')
