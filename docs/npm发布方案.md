# 公网 npm 发布方案

把本仓的产物发到**公网 npm**，让团队同事**一行命令**就能装上，
而不是每人各配一次 `file:` 路径 / junction。

> 本文是**方案与边界说明**，不是操作手册。插件本身的安装/配置/排障见
> `packages/dsh-plugin/README.md`；工程约定见 `.agents/skills/repo-conventions/SKILL.md`。
>
> ⚠️ **本文件已按实际落地形态重写过一次**：初版推荐「把 `@ai-token-report/*`
> 全仓改名后直接发 workspace 包」，那个结论是**错的** —— 见 §1。

---

## 0. 已确定的决策

| 项 | 决定 |
|---|---|
| registry | 公网 `registry.npmjs.org` |
| 插件包名 | `dsh-plugin-token-report`（unscoped） |
| License | **MIT**（与已发布的 CLI 包 `dsh-token-report` 一致） |
| 发布形态 | **打包到 `dist/` + 手写发布清单**（§1） |

### 家族命名（现状）

| 目录 | npm 包名 | 状态 |
|---|---|---|
| `packages/cli` | `dsh-token-report` | 已产出（`cli/scripts/build-npm.ts` → `cli/dist`） |
| `packages/dsh-plugin` | `dsh-plugin-token-report` | ✅ 本次落地（`dsh-plugin/scripts/build-npm.ts` → `dsh-plugin/dist`） |

---

## 1. ★ 结论：走「打包 + 独立清单」，**不需要全仓改名**

初版方案把「发布」和「改名」绑在了一起，理由是 npm 要求「包名 == manifest 的 `name`」。
这个前提没错，但**结论跳了一步**：只要发布物用一份**自己写的清单**，
workspace 里的包名可以原封不动。

`packages/cli/scripts/build-npm.ts` 已经确立了这套做法，插件的脚本与它同源：

| 好处 | 说明 |
|---|---|
| **零改名** | `@ai-token-report/*` 在仓内 100+ 处引用、11 条 `tsconfig.paths` **一处都不用动** |
| **零运行时依赖** | `bun build` 把 `core` / `shared` 内联，发布清单里**没有 `dependencies`** |
| **绕开 private 与 `workspace:*`** | 那两个包是 `private: true`、从未发布；若直接发 workspace 包，`workspace:*` 会被改写成指向它们的版本号 → 同事安装期 **404** |
| **发布名与 dev 名解耦** | 仓库里叫 `@ai-token-report/dsh-plugin`（`tsconfig` / workspace 解析依赖它），npm 上叫 `dsh-plugin-token-report`；映射只发生在构建脚本一处 |

⚠️ 代价（要知情）：`shared` / `core` **没有作为独立包发布**，所以其它团队插件
目前**不能** `import` 本仓的类型与口径函数。见 §5。

---

## 2. 插件发布管线（已落地）

```bash
bun run --filter '@ai-token-report/dsh-plugin' build:npm    # → packages/dsh-plugin/dist
bun run --filter '@ai-token-report/dsh-plugin' verify:npm   # ★ 发布前必跑
npm publish packages/dsh-plugin/dist
```

**根目录快捷方式**（与外层 `package.json` 的 scripts 一一对应，免记 `--filter`）：

```bash
bun run build:npm:plugin      # = --filter '@ai-token-report/dsh-plugin' build:npm
bun run verify:npm:plugin     # ★ 发布前必跑
bun run publish:plugin:dry    # 只打包断言 tarball，不发布
bun run publish:plugin:next   # 发 --tag next（首版就走这个）
bun run publish:plugin        # 正式发 latest
```

⚠️ 根脚本用的是 `bun publish`，与上面的 `npm publish packages/dsh-plugin/dist`
**等价**（都读 `~/.npmrc` 凭证、都发同一个 registry），差别只有两点：
`bun publish` 不受本机 `NODE_USE_ENV_PROXY` 的影响（`npm` 会因此启动即崩，见 §6），
且它**不接受目录参数** —— 必须 `--cwd <dist>`，写成
`bun publish --dry-run packages/dsh-plugin/dist` 会报 `EISDIR`。

产物形态：

```
packages/dsh-plugin/dist/
  package.json      ← 发布清单（name = dsh-plugin-token-report，无 dependencies）
  index.js          ← 宿主半（Node 跑，73.1 KB）
  client.js         ← 浏览器半（__ModuleLoader__ 信封，26.9 KB）
  cordis.patch.yml  ← 挂载声明（生成，不是拷贝）
  README.md
```

### 🚨 三条硬约束（写错了同事那边是「装上了但不生效」）

| 约束 | 违反的后果 | 谁兜住 |
|---|---|---|
| `cordis.patch.yml` 的 `name` 必须是**发布名** | DSH 启动报「找不到模块」。DSH loader 拿这个字符串去 `import()` | 脚本**生成**该文件；`verify:npm` 断言 |
| 浏览器半信封 `id` 必须等于**发布名** | 「面板静默消失」，**不报错**。`build-client.ts` 用的是 workspace 名（开发直挂时正确），故在打包时改写一次 | `verify:npm` 断言 |
| 宿主半不得有顶层 `bun:` / workspace 包 import | Node 加载即崩，而**所有 Bun 下的测试依然全绿** | 构建脚本 + `verify:npm` 双重断言 |

> 第三条对应 AGENTS.md 的两条铁律（不要 external `@ai-token-report/*`、
> `bun:sqlite` 只能经 `core/db/driver.ts` 取）。它们在「发布形态」上会变成
> Node 侧的加载失败，所以必须在构建期钉死。

---

## 3. 发布前必跑：`verify:npm`（19 项）

对着**真正要发布的那份 `dist/`** 做三件事：

| 步骤 | 覆盖 |
|---|---|
| 1. 构建 | 复用 `build:npm`，构建参数只有一处真源 |
| 2. 清单与挂载声明自检 | 包名 / license / **无 `dependencies`** / 无 `workspace:` 残留 / `files` 落齐 / patch 是顶级数组且 `name` == 包名 == 信封 id / 无顶层 `bun:` import / `dsh.bundle.patch` 存在 / `exports["./client"]` |
| 3. **真 Node 装载** | 临时目录 + 目录联接复刻 profile 布局，用**真 Node** `import` 宿主半，断言 `name` / `apply` / **`inject` 挂在默认导出上** / `queryUsage` |

### 🚨 为什么第 3 步必须用「真 Node」，不能用 `process.execPath`

实测：`bun run` 下 `process.execPath` **就是 `bun.exe`**。
用它起子进程 = 同一个运行时跑两遍，两边当然一致 —— 什么都没验证到。

`packages/dsh-plugin/verify/verify-resolution.ts`（旧的 9 项检查）就踩在这个坑上：
它在 Bun 下用 `createRequire` 做「Node 语义」解析，而 Bun 的解析器会去查
`node_modules/.bun/`，真 Node 看不见那里。**所以 `verify:npm` 才是发布形态的
真 Node 闸门**；`verify-resolution` 只能算「Bun 侧解析形状」检查。

### 🚨 为什么要连「宿主模块树」，而不是本仓的 `node_modules`

实测踩到：本仓的 `@deepseek-ai/*` 由 bun 放在 `node_modules/.bun/...` 下，
`node_modules/@deepseek-ai` 这个路径**根本不存在**。照它建 junction 会得到一个
**悬空联接**，于是「环境布局不对」被伪装成「产物加载失败」。

脚本的候选顺序（先到先得，且**断言到具体包**，只看上层目录会被悬空联接骗过）：

1. `ATR_DSH_MODULES`（换机器 / 换安装方式的逃生门）
2. `~/.bun/install/global/node_modules` ← 本机 DSH 的实际安装位置
3. 本仓 `node_modules`（兜底，真 Node 可能解析不到，届时**如实报失败**）

连对之后，产物解析到的 telemetry 就是**宿主实际加载的那一份**。

---

## 4. 上线清单

```
① bun test && bun run typecheck
② bun run verify:npm:plugin                                      # 19 项必须全绿
③ bun run publish:plugin:dry                                     # 断言 tarball 内容
④ 首版走 0.1.0-rc.1 + --tag next（不污染 latest；npm 的 unpublish 有 72h 与配额限制）
     → bun run publish:plugin:next
⑤ 临时 profile 真装真启动：
     dsh plugin --profile tmp add dsh-plugin-token-report@next
     dsh --profile tmp --dump-config | Select-String token-report
     dsh --profile tmp --no-open
   断言 $DSH_HOME/token-report/outbox 目录被创建
   （这是「后端真的构造了」的唯一直接证据）
⑥ 确认无误后再发 0.1.0 为 latest
     → bun run publish:plugin
```

⚠️ **名字先占**：unscoped 包名是**先到先得**，`dsh-plugin-token-report` /
`dsh-token-report` 这类通用名建议尽早发一版占住，被抢走后只能改名，
而改名会连带 `cordis.patch.yml` 的 `name`（= 客户端模块图 id）。

⚠️ **`dsh plugin` 内部转发给 pnpm**（不是 bun）—— 这是 DSH 自己的约定，
与本仓的 bun 铁律不冲突，但文档要对同事说清楚。

⚠️ **本机 node / npm / pnpm 需要干净环境**：`NODE_USE_ENV_PROXY=1` +
`http_proxy` 会让 Node ≥22 在 import `node:http` 时抛 `ERR_PROXY_INVALID_CONFIG`。
验证脚本已用 `core/verify/lib/runtime.ts` 的 `cleanChildEnv()` 处理；
手动跑 `npm publish` 时注意同样的问题。

---

## 5. 尚未做 / 需要你决定

| # | 事项 | 说明 |
|---|---|---|
| 1 | **`shared` / `core` 要不要独立发布** | 当前形态下，别的团队插件**无法** `import` 本仓的口径函数与协议类型（它们只以「内联进 CLI / 插件产物」的形式存在）。若「工具包」的目标是**被别的插件 import**，则仍需单独发布 —— 那时才需要面对 §1 里被绕开的改名问题（或给它们各写一份 `dist` 清单） |
| 2 | **仓库里没有 `LICENSE` 文件** | 发布清单已写 `"license": "MIT"`，但仓库根没有 LICENSE 正文。公网包建议补一个 |
| 3 | **`README.md` 就是公网首页** | npm 页面正文取包根 README（`files` 挡不住）。现在是 35 KB 的内部开发与排障文档（含 Windows junction 命令、`.agents/skills/*` 引用）。要么接受，要么拆成「公网版 README + 内部 `docs/`」 |
| 4 | **插件 README 尚无发布章节** | 安装一节（§2.3）仍只写了 junction / `file:`，没有 `dsh plugin add` 的路径 |

---

## 6. 已知风险

| # | 风险 | 现状与对策 |
|---|---|---|
| R1 | **双份 telemetry 实例** | 插件把 `@deepseek-ai/dsh-session-telemetry` 声明为 peer，而 pnpm 默认会自动安装 peer → profile 里可能出现第二份。实测**不会立刻炸**（cordis 内部身份用 `Symbol.for('cordis.*')`，且产物里 `instanceof Service` 出现 0 次），但会让诊断变难。`verify:npm` 会**打印产物解析到的那一份路径**便于比对 |
| R2 | 公网 `latest` 是**旧版** | `@deepseek-ai/dsh-session-telemetry` 的 `latest` = `0.0.1-rc.1`（事件名都不同的旧 API）。发布清单里 peer 范围刻意收在 `^0.1.5-rc.1` —— 按 semver 的预发布规则**只**匹配 `0.1.5-*`，天然躲开 `latest` |
| R3 | 发布不可撤销 | unpublish 有 72 小时与配额限制。故首版走 `--tag next`（§4） |
| R4 | 内部设计披露 | 包里含上报协议形状、Bearer 凭证方案、脱敏白名单策略、outbox 设计。**已扫描确认：产物与 README 里没有真实凭证、没有内网域名**（唯一命中是示例假 token）。剩下的是「设计公开」而非「凭证泄露」 |
| R5 | 出问题时的失败模式 | 本插件最怕的不是报错而是**静默不上报**。`token_usage_diagnostics` 是排查入口；发布形态下还要能看出「装的是哪一版」 |

---

## 7. 实测证据索引

| 结论 | 验证方式 |
|---|---|
| 产物只 external `@deepseek-ai/*`，`core`/`shared` 已内联 | 构建后抓 `dist/index.js` 的静态 import |
| 真 Node 能加载发布产物 | `verify:npm` 第 3 步（实测 `node v22.21.1`，`name=token-report`，`inject` 在默认导出上） |
| `bun run` 下 `process.execPath` 是 `bun.exe` | `bun -e "console.log(process.execPath)"` |
| 本仓 `node_modules/@deepseek-ai` **不存在**（bun 放在 `.bun/` 下） | `Test-Path` + 真 Node 从该路径解析失败 |
| 连全局安装树后产物可加载、且 telemetry 与宿主同源 | 临时目录 + junction + 真 Node |
| `bun pm pack` 会跑 `prepack`，失败即中止打包 | 临时包放一个必失败的 `prepack` |
| `workspace:*` → `0.1.0`，`workspace:^` → `^0.1.0`（`exact = true` 下同样） | 临时 workspace 打包后解包读清单 |
| `bun build` 不出 `.d.ts` | `bun build --help` 无 `dts` / `declaration` |
| `@deepseek-ai/dsh-session-telemetry` 的 `latest` = `0.0.1-rc.1` | `bun pm view … dist-tags` |
| 包名公网可用 | `GET https://registry.npmjs.org/<name>` |
