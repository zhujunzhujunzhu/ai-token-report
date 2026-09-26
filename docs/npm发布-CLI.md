# 公网 npm 发布：CLI（`dsh-token-report`）

> **当前发布入口见 [发布检查与事故恢复](发布检查与事故恢复.md)。**
> 根目录 `publish:*` 会强制完整验证并发布同一份已验证 tarball；下文直接发布 dist 的命令为历史记录。

把 `packages/cli` 作为一个**独立工具**发到公网 npm。

> 这是**操作手册**，讲「怎么发、发之前必须断言什么」。
> 插件 + 工具包的发布方案在 `docs/npm发布方案.md`（另一条线，范围不含 CLI）。
> 工程约定以 `.agents/skills/repo-conventions/SKILL.md` 为准。

---

## 0. 结论速览

| 项 | 值 |
|---|---|
| 包名 | **`dsh-token-report`**（unscoped，实测未被占用） |
| bin | `dsh-token-report` + `dsh-token`（短名） |
| 依赖 | **零运行时依赖**（`shared`/`core`/`server` 全部内联进单文件产物） |
| 运行时 | Node ≥22.15（`node:sqlite`）与 Bun ≥1.1（`bun:sqlite`） |
| 页面资源 | `packages/web-local/dist` 内嵌进产物，装完即用 |
| 构建 | `bun run build:npm:cli`（= `--filter '@ai-token-report/cli' build:npm`） |
| 验证 | `bun run verify:npm:cli`（= `--filter '@ai-token-report/cli' verify:npm`） |
| 发布 | `bun run publish:cli:dry` → `publish:cli:next` → `publish:cli` |

**为什么"零依赖"是关键**：`shared`/`core`/`server` 在 workspace 里都是
`private: true`、依赖写成 `workspace:*`，**发不出去**。
`bun build` 把它们内联后，产物 `dependencies` 为空，用户装完就能跑，
也**绕开了** `docs/npm发布方案.md` §3 那条「包改名牵动全仓 ~120 处」的成本 ——
不需要把 `@ai-token-report/*` 改成公网名。

---

## 1. 包名为什么不是 `dsh-token-stats`

`dsh-token-stats` **已被占用**（实测 HTTP 200）：

| 包名 | 状态 | 拥有者 |
|---|---|---|
| `dsh-token-stats` | ❌ 已占用 `0.2.0` | `h1a3x`（是个 DSH 浮动面板插件，非 CLI） |
| `dsh-token` | ⚠️ 已占用 `0.0.1` | `tudamu`，**只是占名、没有 bin** |
| `dsh-token-report` | ✅ 可用 | —— |

⚠️ `dsh-*` 命名空间已经很挤：`dsh-usage` / `dsh-token-usage` / `dsh-stats` /
`dsh-metrics` / `dsh-session-stats` / `dsh-cost` 被 **6 个不同的人**占了。

`dsh-token` 这个 **bin 名**仍然可用（对方没声明 bin），所以短命令保留。

---

## 2. 🚨 发布前必须断言的 6 件事

`verify:npm` 会自动跑完整套（对着**真正要发布的那份产物**，在 Node 与 Bun 下各跑一遍）：

| # | 断言 | 破掉会怎样 |
|---|---|---|
| 1 | shebang 是 `#!/usr/bin/env node` | 源文件写的是 `bun`。不改的话 Node 用户执行时报 `env: bun: No such file or directory` |
| 2 | 产物**没有顶层** `bun:sqlite` import | Node 在 `import` 阶段直接崩，报错完全指不到这里 |
| 3 | `dependencies` 为空 | 带上 `workspace:*` 或未发布的包名 → 用户装完 `MODULE_NOT_FOUND` |
| 4 | `web-local/index.html` 已内嵌 | `web` 子命令对 npm 用户不可用 |
| 5 | Node 与 Bun 的四项 token **逐字段一致** | 双驱动适配层抹平得不彻底，只在其中一个运行时上错 |
| 6 | 本地页面 API 的 `totalTokens`/`calls` 与 CLI 一致 | 口径出现第二个真源（本仓第一铁律） |

第 2 条最容易复发：只要有人在 `core/db` 里直接 `import ... from 'bun:sqlite'`
（绕过 `driver.ts`），产物顶层就会多出这一行，而**所有在 Bun 下跑的测试依然全绿**。

---

## 3. 两个只在发布形态上才成立的约束

### 3.1 🚨 静态资源不能用 `Bun.file()` / 服务端不能只有 `Bun.serve`

`packages/server` 原本用 `Bun.serve({ fetch: handler })` + `Bun.file()`。
两者都是 Bun 专有，产物发到 Node 上就是「页面白屏 / 服务起不来」。

现在：请求处理器保持 Web 标准的 `Request`/`Response` 不动，
只在最外面按运行期二选一（`server/src/index.ts` 的 `tryListen`）：

| 运行时 | server | 端口占用的表现 |
|---|---|---|
| Bun | `Bun.serve` | 同步抛错 |
| Node | `node:http`（`server/src/serve-node.ts` 桥接） | 异步 reject |

静态文件统一改用 `node:fs/promises`。

⚠️ **不要为 Node 另写一套路由** —— 那会产生第二个「什么路径返回什么」的实现，
两边必然漂移，且不会报错。

### 3.2 🚨 两个 SQLite 驱动不能合并成一个

实测（本机 Node 22.21.1 / Bun 1.4.2，Windows）：

| 组合 | `close()` 后能否删库文件 |
|---|---|
| Node + `node:sqlite` | ✅ 干净 |
| Bun + `bun:sqlite`（全部 `finalize()`） | ✅ 干净 |
| **Bun + `node:sqlite`** | ❌ **EBUSY，残留 4 MB `-wal`** |

第三行意味着「统一走 `node:sqlite` 以消除双路径」是**行不通的**：
`node:sqlite` 根本没有 `finalize()`，句柄泄漏无法补救，`--reset-db` 会永远失败。

所以 `core/db/driver.ts` 保留两个后端，并保证：
- `finalize()` 在 Bun 上**真的调用**，在 Node 上是空操作
- 绑定值在**唯一入口**把 `undefined` 归一成 `null`
  （`node:sqlite` 对 `undefined` 直接抛 `Provided value cannot be bound`，
  而 `UsageRecord.cwd/turn/step` 都是可选字段）

两个后端的等价性由两处守住：
`packages/core/verify/run-driver-parity.ts`（逐行对照）
与 `packages/core/test/db.test.ts` 的 `assertSameTotals()`。

---

## 4. 发版流程

**根目录快捷方式**（与外层 `package.json` 的 scripts 一一对应，免记 `--filter`）：

```bash
bun run build:npm:cli      # web-local build + cli build:npm（web-local 必须先构建）
bun run verify:npm:cli     # ★ 发布前必跑（零依赖 + 双运行时）
bun run publish:cli:dry    # 只打包断言 tarball，不发布
bun run publish:cli:next   # 发 --tag next（首版就走这个）
bun run publish:cli        # 正式发 latest
```

展开就是下面这套（`bun` 与 `npm` 二选一都能发，见下方说明）：

```bash
# ① 构建（会把 web-local/dist 一起内嵌）
bun run --filter '@ai-token-report/web-local' build   # 页面资源，必须先构建
bun run --filter '@ai-token-report/cli' build:npm

# ② 零依赖 + 双运行时验证（这一步会自己重建产物）
bun run --filter '@ai-token-report/cli' verify:npm

# ③ 看 tarball 里到底有什么
npm publish packages/cli/dist --dry-run

# ④ 先发 rc / next，本地真装一次确认无误，再发 latest
npm publish packages/cli/dist --tag next
npm i -g dsh-token-report@next && dsh-token-report --period today

npm publish packages/cli/dist          # 正式
```

⚠️ 根脚本用的是 `bun publish`，与上面第 ③④ 步的 `npm publish` **等价**
（都读 `~/.npmrc` 凭证、都发同一个 registry）。差别只有两点：
`bun publish` 不受本机 `NODE_USE_ENV_PROXY` 的影响（`npm` 在本机会启动即崩，见 §6），
且它**不接受目录参数** —— 必须 `--cwd packages/cli/dist`，
写成 `bun publish --dry-run packages/cli/dist` 会报 `EISDIR`。

⚠️ **发布不可撤销**：npm 的 unpublish 有 72 小时与配额限制，
被依赖后基本不能撤。首版务必先走 `--tag next`。

---

## 5. 待决定（发布前必须拍板）

| # | 决定 | 现状与影响 |
|---|---|---|
| 1 | **License** | 产物 manifest 现在写的是 `MIT`，但**仓库里没有任何 LICENSE 文件**。公网包默认「保留所有权利」，写 `MIT` 却无正文属于名不副实。要么加一份 `LICENSE`，要么改成 `UNLICENSED` |
| 2 | **`repository` / `homepage`** | 现在填的是 `github.com/zhujunzhujunzhu/ai-token-report`。若该仓不对外可见，等于公开内部地址 |
| 3 | **上报的 client 名** | `packages/cli/src/deliver.ts` 上报时 `name: 'dsh-token-stats'`，而插件用的是 `dsh-token-report` —— 同一个组织在门户上会显示成两个客户端。改它会改变已上报数据的聚合口径，**没动**，等你确认 |
| 4 | **README 口径** | `packages/cli/README.md` 是**面向公网用户**写的（已就位）。npm 页面显示的就是它 |

---

## 6. 环境前提（本机实测，会影响能否发布/验收）

- 🚨 **本机 Node 全家桶启动即失败**：`NODE_USE_ENV_PROXY=1` 会让
  Node v22.21.1 在加载 `node:http` 时抛
  `ERR_PROXY_INVALID_CONFIG: Invalid proxy URL` —— 连 `node -e "console.log(1)"` 都跑不起来。
  实测把 `NODE_USE_ENV_PROXY` 去掉、或设成 `0`，立刻恢复正常
  （改 `HTTPS_PROXY` 的值**没用**，触发点是这个开关本身）。
  → 验证脚本已自动为子进程剔除该变量（`packages/core/verify/lib/runtime.ts`），
    但你手工跑 `node` 时需要自己清掉。
- ⚠️ **`~/.npmrc` 里的公网 npm 凭证实测已失效**：`npm whoami` 返回
  `401 Unauthorized`。发布前需要重新 `npm login` 或更新 token。
  （`docs/npm发布方案.md` §6 记的是「已有凭证」，与实测不符，以实测为准。）
- 🚨 **`bun run` 下 `Bun.spawnSync(['node', ...])` 执行的其实是 Bun**：
  跨运行时验证会静默退化成「同一个运行时跑两遍」并假报成功。
  验证脚本因此**逐个探测候选可执行文件**并断言 `driver=` 取值；
  详见 `packages/core/verify/lib/runtime.ts`。

---

## 7. 实测证据索引

| 结论 | 验证方式 |
|---|---|
| `node:sqlite` 在 Node 22.21.1 无需 flag 可用（仅 ExperimentalWarning） | 直接 `import('node:sqlite')` |
| Bun 1.4.2 也实现了 `node:sqlite`，但 `close()` 不释放句柄 | 写库→`close()`→`rmSync` 抛 EBUSY，`-wal` 残留 4 MB |
| Bun 下 `bun:sqlite` 全部 `finalize()` 后可正常删库 | 同上，路径改为全 finalize |
| `bun build --target=node` 会把 `bun:sqlite` 留在产物顶层 | 构建后 grep 产物（未用 driver 适配层时命中第 1584 行） |
| Node 与 Bun 的统计输出逐行一致 | `verify:npm` 四项 token 逐字段比对 + `run-driver-parity.ts` |
| 本地页面 API 与 CLI 口径一致 | `verify:npm` 断言 `totalTokens`/`calls` 相等 |
| `NODE_USE_ENV_PROXY=1` 是 Node 崩溃的唯一触发点 | 逐个变量增删对照，见 §6 |
| `bun run` 下 spawn 的 `node` 是 Bun | 子进程打印 `process.version` + `typeof Bun` |
| 包名占用情况 | `GET https://registry.npmjs.org/<name>` |
