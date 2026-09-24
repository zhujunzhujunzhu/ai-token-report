---
name: repo-conventions
description: Follow this repo's engineering conventions when adding code, tests, packages, or dependencies to ai-token-report. Use when running test/typecheck/build, choosing bun instead of npm/yarn/pnpm, deciding where a test file lives, adding a workspace dependency, naming fields (snake_case vs camelCase), or writing Chinese code comments; not for token metric formulas, log decoding, or identity attribution.
version: 1.0.0
---

# 本仓工程约定

本文件管的是**怎么写**（工具链、目录、命名、注释、依赖），
不管**写什么**（口径 / 日志解析 / 身份各有专门 skill）。

---

## 0. 五条铁律（先记这个，其余都是展开）

| # | 规则 | 违反了会怎样 |
|---|---|---|
| 1 | 只用 **`bun`**，绝不用 `npm` / `yarn` / `pnpm` | 装出不同的依赖树；`bun.lock` 与 `node_modules` 打架 |
| 2 | 测试用 **`bun test`**，不引入 vitest / jest | 多一套配置与 transform，且与 `Bun.serve`、zstd 等原生能力对不上 |
| 3 | **改口径必须同改 `packages/shared/test/metrics.test.ts`** | 实测结论（94.3% / 19.3 倍）失去防线，两端口径悄悄漂移 |
| 4 | **提交前 `bun test && bun run typecheck` 两者都必须过** | typecheck 是契约漂移的唯一拦截点，跳过它等于等运行时看空图表 |
| 5 | **代码注释一律中文**，注释解释「为什么」而不是「做什么」 | 见 §6，这是本仓最显眼的风格约定 |

> **为什么是 bun 而不是 npm**：本项目重度依赖 Bun 原生能力 —— `Bun.serve`
> （本地服务）、`Bun.file`（静态托管）、`bun test`（测试运行器）、
> `bun build`（插件打包）。换成 npm 不是「换个包管理器」，是换掉运行时。

---

## 1. 常用命令（照抄即可）

```bash
bun install
bun test                        # 全仓：7 个文件 / 168 个测试
bun run typecheck               # 7 个包，每个都必须 exit 0
bun run build                   # web-local + web-portal 两个 web

bun test packages/shared        # 只跑单包
bun run --filter '@ai-token-report/server' test

bun run stats -- --period today # 终端统计
bun run web                     # 本地页面（需先 bun run build:local）
bun run --filter '@ai-token-report/server' start   # 部门服务端
bun run dev:local               # web-local 开发服务器
bun run dev:portal              # web-portal 开发服务器
```

### 1.1 包过滤的两种写法都对，但别混用

| 目的 | 写法 |
|---|---|
| 跑某个包的脚本 | `bun run --filter '@ai-token-report/server' test` |
| 从根脚本转发参数 | **必须带 `--`**：`bun run stats -- --period today` |

⚠️ `bun run stats --period today` **不会**把参数传给 CLI —— 根脚本是
`bun run --filter ... start`，参数会被 bun 自己吃掉，表现为「参数没生效但也不报错」。
这类静默失效最难查，所以根脚本一律用 `--` 转发。

### 1.2 退出码约定（写脚本 / 计划任务时要认）

| 命令 | 退出码 |
|---|---|
| `dsh-token` 统计 | `0` 成功 / `1` 找不到会话目录 / `2` 参数错误 |
| `dsh-token web` | `0` 正常停止 / `1` 静态产物缺失或启动失败 / `2` 参数错误 |
| `dsh-token report` | `0` 成功（含 dry-run、本轮无新增）/ `2` 参数错误 / **`3` 投递失败**（pending 保留，下轮重试） |

> `report` 的 `3` 是刻意与 `2` 分开的：计划任务据此判断「该重试」还是「配错了」。

---

## 2. 目录与包职责

| 路径 | 职责 | 一句约束 |
|---|---|---|
| `packages/shared` | **契约单一真源**：上报 DTO、查询响应、口径公式 | ★ **不得依赖任何运行时**（前端 / CLI / 插件都 import 它） |
| `packages/core` | 内核：decode / scanner / aggregate / range / state / format / types / home / identity-store | 只依赖 `shared`；**HTTP 投递不在 core** |
| `packages/core/src/db` | ★ **本地 SQLite 增量库**：schema / ingest / query / stats | **独立入口** `@ai-token-report/core/db`（`bun:sqlite` 不得污染 web/插件） |
| `packages/cli` | 命令入口：`cli.ts` / `deliver.ts` / `report.ts` | 唯一面向用户的命令入口 |
| `packages/server` | 上报接收 + 本地直查 + 部门统计 + 静态托管 | 一个 server 两副面孔，见 `index.ts` 顶部表格 |
| `packages/web-local` | 本地页面（`/api/local/*`） | 独立构建、独立部署 |
| `packages/web-portal` | 部门看板（`/api/v1/stats/*`） | ⚠️ 仅骨架，真实看板待 S8 |
| `packages/dsh-plugin` | DSH 插件 | 身份已就位，上报后端待 S9（**当前不注册 = 不会意外上报**） |

> ⚠️ **`core/db` 走独立入口，不在 `core` 主入口 re-export**：
> 它依赖 `bun:sqlite`，若挂在主入口上，任何 import `core` 的代码
> （web 前端、DSH 插件）都会被拖进数据库依赖。
> 新增跨包 import 时记得同时在那个包的 `tsconfig.json` 里加 `paths` 映射
> （`"@ai-token-report/core/db": ["../core/src/db/index.ts"]`）。

### 2.1 依赖方向（不可逆）

```
shared  ←  core  ←  cli
   ↑        ↑       ↑
   └────────┴───────┴── server / web-local / web-portal / dsh-plugin
```

- **`shared` 必须零运行时依赖** —— 它要能同时跑在浏览器、Bun、DSH 插件进程里。
  想给它加 `node:fs` / `node:zlib` 之类的 import 时，先问：前端也用得上吗？
- `core` 只依赖 `shared`；`cli` 依赖 `core` + `shared` + `server`（`--web` 要内嵌服务）。
- 新增跨包 import 前先确认**没有形成环** —— 环会让 `tsc` 与 `bun build` 表现不一致。

> 迁移期旧目录（`dsh-token-stats/`、`frontend/`、`p0-verify/`、`dsh-session-inspector/`）
> **已全部删除**。看到 `ARCHITECTURE.md` 里提到它们时，那是在讲历史。
> `frontend/` 只剩 `node_modules`/`dist` 残留空壳，**不在 workspace 内、勿改**。

---

## 3. 测试约定

### 3.1 位置：`<pkg>/test/*.test.ts`

测试文件与被测代码**同包**，不集中到根目录的 `test/`。已落地的 8 个文件：

| 文件 | 覆盖 |
|---|---|
| `packages/shared/test/metrics.test.ts` | ★ 口径公式与实测结论 |
| `packages/core/test/core.test.ts` | 解码 / 扫描 / 聚合 |
| `packages/core/test/identity-store.test.ts` | 身份文件原子写入与降级 |
| **`packages/core/test/db.test.ts`** | ★ **本地库：SQL 与直扫两条路径逐位一致**、幂等、增量、降级 |
| `packages/cli/test/incremental.test.ts` | 增量水位线 |
| `packages/server/test/identity.test.ts` | 凭证表与校验 |
| `packages/server/test/local-api.test.ts` | 本地直查路由 |
| `packages/dsh-plugin/test/identity.test.ts` | 插件侧身份解析 |

> `db.test.ts` 里的 `assertSameTotals()` 是本次 SQL 化迁移的**核心防线**：
> 它逐字段比对 SQL 路径与直扫路径的四个 token 列 + calls。
> 只比 `total` 是不够的 —— 「input 少 100、cacheRead 多 100」这类错误
> 会让 total 恰好相等而静默通过。改数据源时**不要削弱这组断言**。

### 3.2 端到端脚本不是 `bun test` 文件

`packages/server/test/e2e-identity.ts` **是 `bun run` 执行的脚本**，不是测试文件 ——
它真的起两个 HTTP 服务（部门 + 本地）跑完整署名链路，用 `console.log` 打
`✅ / ❌` 并自行 `process.exit`。

⚠️ 命名上要小心：`bun test` 会捡 `*.test.ts`。**别把端到端脚本命名为 `*.test.ts`**，
否则它会被 `bun test` 当成单元测试并发跑起来，去抢 `18787` 这类固定端口。

### 3.3 人工验证脚本放 `<pkg>/verify/`

`packages/web-local/verify/` 下的 `verify-data.ts` / `verify-render.ts` /
`verify-layout.ts` / `verify-charts.ts` 用于**人工**验证渲染与图表，
用 `bun run --filter '@ai-token-report/web-local' verify` 触发。
它们不进 CI，也不该被当成回归测试 —— 渲染结果需要人眼判断。

`packages/cli/verify/verify-db-parity.ts` 用于**人工**在真实日志上做
SQL 路径 vs 直扫路径的双轨对照（5 个时间窗 × 7 个分组维度 × 2 个序列粒度）：
`bun run packages/cli/verify/verify-db-parity.ts`。
改动数据源后应当跑一次 —— 它能在真实数据上抓住单元测试造不出的边界。

### 3.4 断言要固化「为什么」

口径测试里断言的不是随便一个数，而是实测结论。例如：

```ts
// 好的断言：写清这个数从哪来、错了会怎样
expect(cacheHitRate(sample)).toBeCloseTo(0.943, 3) // 9845 条样本实测 94.3%
```

改公式时**必须同步改这里的断言**，否则它就从「防线」退化成「噪音」，
下一个人会选择把它删掉 —— 那才是真正的损失。

---

## 4. 类型与字段命名

### 4.1 snake_case / camelCase 的边界

| 场景 | 命名 | 例 |
|---|---|---|
| DB 列 / HTTP 线上字段 | **`snake_case`** | `cache_read_tokens` |
| TypeScript 内存类型 | **`camelCase`** | `cacheReadTokens` |
| 本地身份文件（JSON） | `camelCase` | `createdAt` / `updatedAt` |

**转换只发生在边界**：服务端落库（`ingest.ts`）、前端取数（`web/src/api/`）。
内核一律 camelCase —— 在内核里混进 snake_case，会让「这个字段是线上的还是内存的」
彻底说不清。

### 4.2 tsconfig 是逐包的，不是继承的

7 个包**各自**有一份 `tsconfig.json`，没有 `extends` 的公共基础。
共同点（`strict` / `verbatimModuleSyntax` / `noEmit`）靠手工保持一致。

⚠️ **跨包 import 靠各包的 `paths` 显式映射**，例如 `packages/cli/tsconfig.json`：

```jsonc
"paths": {
  "@ai-token-report/shared": ["../shared/src/index.ts"],
  "@ai-token-report/core":   ["../core/src/index.ts"],
  "@ai-token-report/server": ["../server/src/index.ts"]
}
```

**新增一个跨包 import，就要在用到它的那个包的 tsconfig 里加一条 paths**，
否则 `tsc --noEmit` 会报找不到模块，而 `bun` 运行时却跑得通 ——
这种「运行时对、类型检查错」的落差最容易被误判成工具链坏了。

`verbatimModuleSyntax: true` 还带来一条硬性要求：**纯类型导入必须写 `import type`**，
否则会被当作值导入保留下来。同理，相对 import 一律带 `.js` 后缀
（`import ... from './deliver.js'`），即使源文件是 `.ts`。

### 4.3 `noUncheckedIndexedAccess` 打开着

数组/下标访问的静态类型是 `T | undefined`。写 `arr[i].foo` 会编译失败，
要么用 `arr[i]!`（有把握时），要么先判空。这是刻意的 ——
本仓大量解析外部 JSON，下标越界是真实风险而不是理论洁癖。

---

## 5. 依赖管理

- `bunfig.toml` 里 **`exact = true`**：新增依赖会被锁成精确版本。
  **不要改成 `^`** —— 版本漂移会让不同机器算出不同的数。
- 包间引用一律 **`workspace:*`**：
  ```jsonc
  "dependencies": { "@ai-token-report/core": "workspace:*" }
  ```
- **不要为了一个小工具引入第三方包**。已实测：zstd 用 `node:zlib` 原生支持，
  不需要第三方 zstd 包（见 `dsh-session-log-parsing` skill）。
- 依赖缓存固定在仓内 `.bun-cache/`（`bunfig.toml` 指定），便于离线与 CI 复用。

### 5.1 该不该新增依赖？先过这三问

1. **Bun / Node 原生能做吗？** 能就别加（zstd、HTTP、SQLite 都是原生）。
2. **`shared` 要用它吗？** `shared` 的任何依赖都会传染给前端与插件。
3. **它进运行时的热路径吗？** 插件 `emit()` 是同步热路径，加任何包都要掂量。

---

## 6. ★ 中文注释约定

**这是本仓最显眼的风格要求：所有代码注释用简体中文。**

### 6.1 注释写「为什么」，不写「做什么」

反面教材（复述代码，等于噪音）：

```ts
// 遍历 records
for (const rec of records) { ... }
```

本仓要的写法（解释动机与后果）：

```ts
// 扫描过程中文件被删除是正常竞态：这一轮先忽略它，
// 下一轮的指纹自然不含该文件，会触发重扫。
continue
```

判断标准很简单：**删掉这行注释，下一个改代码的人会不会踩坑？**
会 → 写；不会 → 别写。

### 6.2 文件头要有一段模块说明

每个源文件顶部都有一段块注释，说明**这个文件在整个平台里的位置**。
复杂文件不止一段 —— `packages/server/src/index.ts`、`local-api.ts`、
`packages/core/src/decode.ts` 的头部注释本身就是该模块的设计文档。

### 6.3 三个必须标出来的标记

| 标记 | 用在 | 例 |
|---|---|---|
| `★` | 关键不变量、核心决策 | `★ 这是身份可信边界的落点` |
| `⚠️` | 反直觉、易踩的坑 | `⚠️ 必须显式设置，否则默认值是 10 秒` |
| `🚨` | 硬约束，违反即事故 | `🚨 emit() 在同步热路径，只能入队` |

### 6.4 「不要修」的注释

对**刻意为之的反直觉实现**，注释要明确写「这是刻意的，不要修」。
本仓已有若干处，例如：

- `GET /api/local/identity` **绝不返回 token**（不发回浏览器）
- 校验失败返回 **`200 + ok:false`，不是 401**（401 会让「填错了」和「网络坏了」混淆）
- `cacheHitRate` 分母为 0 时返回 **0 而非 NaN**（否则前端图表出现空点）

这些看起来都像 bug。**没有注释，下一轮重构就会把它们「修」掉，
然后线上出现一个查不出原因的空图表。**

### 6.5 一句英文也别留？

保留原文的情况：**标识符、日志原文、错误信息、协议/API 名**（`Bun.serve`、
`ECONNRESET`、`event_id`）。这些翻译了反而找不到。

---

## 7. 提交前自检

```bash
bun test && bun run typecheck
```

两者都必须过（`bun test` 全绿 + **7 个包全部 exit 0**）。

| 检查项 | 为什么 |
|---|---|
| `bun test` 全绿 | 168 个测试里有口径断言，红了就是口径漂了 |
| `bun run typecheck` 7 包全过 | ★ 契约漂移的主要拦截点。前后端字段对不上时它会**直接编译失败**，而不是等运行时看到空图表 |
| 改了 web 源码 | 还要 `bun run build`，并**刷新页面后确认**（构建产物才是被托管的东西） |
| 改了 `shared` 的字段 | 两端的 typecheck 都会红 —— 这是设计如此，别用 `as any` 绕过 |

---

## 8. 相关 skill

| 主题 | skill |
|---|---|
| 指标口径公式 | `token-metrics-contract` |
| 会话日志解析 | `dsh-session-log-parsing` |
| 身份署名 / 归属 | `identity-attribution` |
| 目录分工与数据通路 | `ARCHITECTURE.md`（不是 skill） |