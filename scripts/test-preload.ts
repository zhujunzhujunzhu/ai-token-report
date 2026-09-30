/**
 * `bun test` 的 preload —— 把 token-report 数据目录钉在一次性临时目录里。
 *
 * ## 为什么必须有这一层
 *
 * 数据目录的缺省值是家目录下的 `~/.ai-token-report`，而且它**刻意不跟随
 * `DSH_HOME`**（见 `core/src/home.ts` 文件头）。于是「用临时 `DSH_HOME` 隔离」
 * 这个用了几百处的老办法**不再隔离任何东西**：仓库里 189 处调用点里只要有一处
 * 没显式给 `dataDir`，那个测试就会读写使用者**真实的** `identity.json` /
 * `usage.sqlite` / `state.json` —— 覆盖的是真署名，而测试全绿、报告全过。
 *
 * 这件事靠 code review 保证不了（调用点太多、而且漏一处不会有任何症状），
 * 所以隔离放在进程级：一旦有测试真的碰了缺省路径，它碰到的也是一次性目录。
 *
 * ## 与显式断言的关系
 *
 * 少数测试**必须**验证缺省值本身（`core/test/home.test.ts`、
 * `dsh-plugin/test/paths.test.ts`）—— 它们自己把这个环境变量删掉再断言，
 * 因此不受这里影响。别在这里「顺手」帮它们跳过。
 *
 * ## 会话日志根：关掉自动发现（同样是为了隔离）
 *
 * 会话日志根现在**默认自动发现**（`$DSH_HOME` + `~/.dsh` + `~/.dsh*` +
 * 各平台应用数据目录下的客户端目录）。只设 `DSH_HOME` **不再是隔离**：
 * 它只是候选之一，测试会连带扫到使用者真实的 home，于是断言随机器漂移
 * （`dsh-plugin/test/paths.test.ts` 就会因此失败）、并且每次 `reportPaths()`
 * 都真的去 readdir 家目录。
 *
 * ⚠️ 这里用 `DSH_TOKEN_REPORT_DISCOVER='0'` 而**不是** `DSH_TOKEN_REPORT_DSH_HOMES`：
 *   `paths.test.ts` 的 `beforeEach` 会删掉 `DSH_HOME` 与插件 `ENV` 里的键，
 *   而它**不清**发现开关 —— 用 `DSH_HOMES` 会把那个文件里「缺省跟 $DSH_HOME」
 *   的断言打成失败。发现开关不在任何测试的备份清单里，能生效且不破坏它们。
 *
 * ## ⚠️ 这一层管不到子进程
 *
 * 实测 Bun 1.4.2：preload 里改的 `process.env` **不会被 `Bun.spawn` 继承**
 * （父进程读得到，子进程读到 `undefined`）。所以**任何 spawn 出 CLI / DSH 的
 * 测试或脚本都必须自己把 `--data-dir` / `DSH_TOKEN_REPORT_DATA_DIR`、
 * 以及 `DSH_TOKEN_REPORT_DSH_HOMES`（钉住日志根）传下去**
 * （helper：`core/verify/lib/runtime.ts` 的 `scratchDataDir()` / `scratchDshHomes()`）。
 * 别以为有 preload 就安全。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'atr-test-data-'))

process.env['DSH_TOKEN_REPORT_DATA_DIR'] = dir
process.env['DSH_TOKEN_REPORT_DISCOVER'] = '0'

process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 测试退出时的清理失败不该影响退出码（Windows 上偶发 EBUSY）。
  }
})