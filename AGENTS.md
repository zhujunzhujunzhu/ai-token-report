# AGENTS.md

DSH token 用量统计平台。四种形态：**CLI / 本地页面 / 部门看板 / DSH 插件**。

本文件是**指针与约束**，不是文档。架构细节在 `ARCHITECTURE.md`，不要在这里复述。

---

## 运行时与工具

- **包管理器 / 运行时：`bun`** —— 不要用 `npm` / `yarn` / `pnpm`
- **测试：`bun test`** —— 不要引入 vitest / jest
- **类型检查：`bun run typecheck`**（逐包 `tsc --noEmit` / `vue-tsc`）
- **构建两个 web：`bun run build`**
- `bunfig.toml` 里 `exact = true`：新增依赖会被锁精确版本，不要改成 `^`

## 常用命令

```bash
bun install
bun test                        # 18 个文件 / 365 个测试，全绿
bun run typecheck               # 7 个包全部 exit 0
bun run build                   # web-local + web-portal 均构建成功
bun run stats -- --period today # 终端统计（读本地库，热态 ~50ms）
bun run stats -- --period today --no-db   # 直扫日志（与库结果做对照）
bun run web                     # 本地页面（需先 bun run build:local）
bun run --filter '@ai-token-report/server' start   # 部门服务端 → 8787/api/health
bun run dev:local               # web-local 开发服务器

# 双轨对照验证（真实日志上跑 SQL vs 直扫，断言两者逐位一致）
bun run packages/cli/verify/verify-db-parity.ts

# 双运行时驱动对照（Node 的 node:sqlite vs Bun 的 bun:sqlite，逐行比对）
bun run --filter '@ai-token-report/core' verify:drivers

# npm 发布产物（独立包 dsh-token-report）：构建 + 双运行时端到端验证
bun run --filter '@ai-token-report/cli' build:npm     # 产物落在 packages/cli/dist
bun run --filter '@ai-token-report/cli' verify:npm    # ★ 发布前必跑

# 发布（根目录快捷方式，CLI 与插件各一套；详见 docs/npm发布*.md）
bun run build:npm:cli && bun run verify:npm:cli       # = 上面两条 + web-local build
bun run publish:cli:dry                               # 只断言 tarball，不发布
bun run publish:cli:next   /   bun run publish:cli     # 真发：先 next，再 latest
bun run build:npm:plugin && bun run verify:npm:plugin  # 插件同款
bun run publish:plugin:dry / :next / publish:plugin    # 插件同款
bun run publish:dry                                   # 两个包一起 dry-run

# DSH 插件：构建 + 五层验证（从内到外逐层接近真实，改插件后全跑）
bun run --filter '@ai-token-report/dsh-plugin' build
bun run packages/dsh-plugin/verify/verify-plugin.ts         # 真 HTTP 往返（55 项）
bun run packages/dsh-plugin/verify/verify-cordis-load.ts    # 真 cordis 装载（10 项）
bun run packages/dsh-plugin/verify/verify-resolution.ts     # Node 语义解析（9 项）
bun run packages/dsh-plugin/verify/verify-client-bundle.ts  # ★ 浏览器半产物（25 项）
bun run packages/dsh-plugin/verify/diagnose-boot.ts web     # 排障：哪个包 import 就炸
```

⚠️ 尚未实现：`bun run report`（需 S3 上报接口）、部门看板页面（S8）。

## 目录

| 路径 | 职责 |
|---|---|
| `packages/shared` | **契约单一真源**：上报 DTO、查询响应、口径公式 |
| `packages/core` | **内核**：decode / scanner / aggregate / range / state / format / types / home / identity-store |
| `packages/core/src/db` | ★ **本地 SQLite 增量库**（独立入口 `@ai-token-report/core/db`）：schema / ingest / query / stats |
| `packages/cli` | **命令入口**：`cli.ts` / `deliver.ts` / `report.ts` |
| `packages/server` | 上报接收 + 本地直查 + 部门统计 + 静态托管 |
| `packages/web-local` | 本地页面（`/api/local/*`） |
| `packages/web-portal` | 部门看板 —— ⚠️ **仅骨架占位，真实看板待 S8** |
| `packages/dsh-plugin` | DSH 插件：实时上报 + `token_usage` 工具 + `ctx.tokenReport` 服务 + **界面用量面板（宿主半 + 浏览器半）**。见其 `README.md` |

> 迁移期旧目录（`dsh-token-stats/`、`p0-verify/`）**已删除**。
> `dsh-session-inspector/` 也已移除（它是与本项目无关的独立插件）。
> `frontend/` 只剩 `node_modules`/`dist` 残留空壳，**不在 workspace 内、勿改**。

## 改代码前先读

| 要改什么 | 先读 |
|---|---|
| 任何指标 / 口径 | `packages/shared/src/metrics.ts` + `.agents/skills/token-metrics-contract/SKILL.md` |
| 字段 / 接口契约 | `packages/shared/src/protocol.ts` |
| 会话日志解析 | `.agents/skills/dsh-session-log-parsing/SKILL.md` |
| 身份署名 / 归属 | `.agents/skills/identity-attribution/SKILL.md` + `ARCHITECTURE.md` §4.5 |
| **工程约定**（命令 / 测试位置 / 命名 / 中文注释 / 依赖） | `.agents/skills/repo-conventions/SKILL.md` + `docs/本仓工程约定.md` |
| 目录分工 / 数据通路 | `ARCHITECTURE.md` |
| 插件方案（历史） | `docs/插件方案.md` |
| **DSH 插件**（配置 / 安装 / 排障 / 为什么不能碰私有字段） | `packages/dsh-plugin/README.md` |

---

## 三条铁律

1. **口径只在 `packages/shared/src/metrics.ts` 定义。**
   要算缓存命中率等指标必须调用它。两端口径不一致的 bug 极难排查。
2. **`cacheRead` 不是 input 的一部分。**
   `input` 是「未命中缓存」那部分；实测 `cacheRead` 占总用量 **94.3%**。
   漏掉它等于漏掉 94% 的用量。
   恒等式：`total = input + output + cacheRead + cacheWrite`，**`reasoning` 不在其中**（它是 output 的子集）。
3. **落库必须存 4 个独立列。** 展示时再相加。
   采集端一旦合并，后续任何拆分都无法还原。

## 非显而易见的约束

- **`packages/shared` 不得依赖任何运行时** —— 前端、CLI、插件都要 import 它。
- **命名约定**：DB 列 / HTTP 线上字段用 `snake_case`（`cache_read_tokens`），
  TS 内存类型用 `camelCase`（`cacheReadTokens`）。转换只发生在边界。
- **上报只需 at-least-once**：幂等键 `event_id = ${sessionId}:${seq}`，
  服务端 `ON CONFLICT DO NOTHING` 去重。插件与 CLI 可同时上报而无需协调。
- **未署名 = 不采集也不上报**。不要加 `unknown` 兜底上报 —— 那是未授权采集。
- **插件 `emit()` 在同步热路径**，只能入队。任何 `await fetch` 都会拖慢 agent loop。
- **🚨 插件的公开方法不得访问 `this.#私有字段`**。cordis 的 `ctx.get(name)`
  返回**服务代理**，而 JS 私有字段穿不过 Proxy —— coordinator 正是通过代理调用
  `emit()`，所以方法体里碰 `#x` 会让**每一次会话事件**都抛
  `TypeError: Cannot access invalid private field`，而单测（拿到真实例）全绿。
  热路径走 `createSink()` 的闭包实现，诊断入口用构造时挂上的自有属性。
  **改插件后必须跑 `packages/dsh-plugin/verify/verify-cordis-load.ts`** ——
  它是唯一能发现这类问题的检查。
- **🚨 插件的 `inject` 必须写在 `default` 导出上，不能写在类上**。
  cordis 读的是**插件条目对象**的 `inject`；类根本不会被实例化
  （`apply()` 是被直接调用的）。写在类上的结果是：插件照常 import、
  `apply()` 也照常跑，但「先等依赖就绪」的语义**静默失效**。
- **🚨 构建插件时不要 external `@ai-token-report/*`**。本仓 workspace 包的
  `main` 指向 `src/index.ts`（Bun 直接吃，**Node 不能**），而 DSH 宿主跑在 Node 上。
  external 出去会让 DSH 加载即失败。同理，动态 import 的说明符要**构建期不可静态分析**
  （用变量拼），否则 bundler 会把 `bun:sqlite` 提到产物的顶层 import。
  这两条都由 `verify/verify-resolution.ts`（Node 语义解析）兜住。
- **🚨 插件与官方 OTel telemetry 后端互斥**：cordis 同一时刻只允许注册一个
  `sessionTelemetry` 服务。装插件必须在 profile 里
  `- id: session-telemetry-otel` + `disabled: true`，
  否则 DSH 启动直接失败（报 service already registered）。
- **🚨 浏览器半只能 `require` DSH 预置的 9 个模块**（react / react-dom /
  cordis / client-store / ui-slots / ui-primitives / ui-dockkit 这几个）。
  前端只预置这一张表，越界会在**物化阶段**抛错，表现为「插件没起来」。
  最阴的一种是 JSX 走**开发版**转换（`react/jsx-dev-runtime`）—— 所以
  `tsconfig.json` 里必须有 `"jsx": "react-jsx"`（bun build 读的是它）。
  这两条由 `build-client.ts` 在**构建期**断言，`verify-client-bundle.ts` 再验一次。
- **🚨 `dsh.client` 声明缺了 `exports["./client"]`（或产物文件不存在）会让
  DSH 启动直接失败**（`ClientPackageCompositionError`），不是「面板不出现」。
  改完插件要重新 `build`，否则下一次启动就起不来。
- **🚨 界面路由必须挂在 `/api` 下**（`ctx.connection.fetch.register`）。
  DSH 的 web 服务器**不做任何鉴权**；`/api` 前缀由 `dsh-client-connection`
  加了 Host/Origin 栅栏 + 浏览器会话 cookie 校验。裸挂在别的路径上
  等于「监听地址一旦改成 `0.0.0.0` 就向整个内网公开本机用量」。
- **🚨 浏览器半不得重算任何口径**。载荷里的 `metrics` 由宿主用
  `shared/metrics.ts` 算好后透传；页面只做格式化与排版。
  在组件里写一遍除法 = 第二个口径实现，且它不会报错。
- **插件的 `connection` 是可选依赖，绝不能写进 `inject`**。`inject` 的语义是
  「等它就绪」，而 headless profile 永远不提供它 —— 写进去等于**上报功能在
  headless 下直接不激活**。用 `ctx.get()` 试一次 + `ctx.inject()` 等它出现。
- **`includeContent` 必须保持 `false`** —— 只采 token 数值与模型名，不采对话内容。
- **服务端默认只监听 `127.0.0.1`**。改 `0.0.0.0` 前必须确认凭证已配置。
- **身份以服务端为准**：`verifyToken()` 返回的 `name` 只可能来自凭证表，
  绝不回显客户端提交的内容。改动此处等于打开冒用身份的口子。
- **不展示金额**（已确认决策）：无单价来源，只展示 token 数。
- **解析失败要降级不要抛错**：身份文件 / 凭证文件损坏时降级为「未配置」并告警，
  抛错会让页面白屏或服务起不来。
- **`Bun.serve` 必须显式设 `idleTimeout`**：默认 10 秒太短 —— 首次冷建库
  要约 15 秒，客户端会看到 `ECONNRESET` 而**服务端一条日志都没有**。
  已在 `server/src/index.ts` 设为 120 秒，改动此处前先读那段注释。
- **🚨 本地库只定义存储，不定义口径**。`packages/core/src/db/query.ts` 里
  **只做 `SUM(原始列)`**，绝不写 `cache_read/(cache_read+input)` 这类公式，
  也绝不返回 `SUM(input+output+...)` 当 total。派生指标一律交给
  `core/types.ts` 的 `derive()` / `shared/metrics.ts`。SQL 里一旦出现公式，
  就存在第二个口径实现 —— 它不会报错，只会让某个数字悄悄不对。
- **🚨 时间分桶（`day`/`hour`）必须在 JS 侧做**，不要用 SQL 的
  `strftime(..., 'localtime')`。实测 SQLite 按**操作系统时区**、JS 按
  **进程 TZ 解析**，在 `bun test` 下两者相差 8 小时（JS 被强制成 UTC），
  表现为趋势图的点整体错位且**只在测试环境暴露**。统一用
  `aggregate.ts` 的 `toDayKey()` / `toHourKey()`。
- **🚨 `core/db` 拿驱动只能经 `driver.ts`**：Bun → `bun:sqlite`，Node → `node:sqlite`，
  两个后端的能力差异（`query()` / `transaction()` / `finalize()`）由它抹平。
  **绝不要在 `core/db` 里重新 `import ... from 'bun:sqlite'`** ——
  `bun build --target=node` 会把它原样留在产物顶层，Node 用户 import 即崩，
  而**所有在 Bun 下跑的测试依然全绿**。`verify:npm` 与
  `core/verify/run-driver-parity.ts` 分别从产物与行为两侧兜住。
- **🚨 SQLite 绑定值里的 `undefined` 必须在 `driver.ts` 归一成 `null`**：
  `node:sqlite` 对 `undefined` 直接抛
  `Provided value cannot be bound to SQLite parameter`，
  而 `UsageRecord.cwd` / `turn` / `step` 都是可选字段（`insertRecords()` 会原样绑定）。
  别在调用点各自判空 —— 归一化只该有一处。
- **🚨 两个 SQLite 驱动不能合并成一个**：实测 **Bun + `node:sqlite`** 在 `close()`
  之后**不释放句柄**（`-wal` 残留 MB 级、`rmSync` 抛 `EBUSY`），
  而它没有 `finalize()` 可补救 → `--reset-db` 会永远失败。
  所以 Bun 必须走 `bun:sqlite`。对应地，`finalize()` 在 Bun 上**必须真的调用**
  （未 finalize 的 `prepare()` 语句会让 `db.close()` 不释放句柄，
  之后删库抛 `EBUSY`，而错误信息完全不提 prepared statement），
  在 Node 后端则是空操作（GC 负责）。
- **🚨 服务端不得依赖 `Bun.serve` / `Bun.file()`**：npm 发布出去的那份 CLI
  要跑在 **Node** 上。请求处理器本身就是 Web 标准的 `Request`/`Response`，
  最外层由 `server/src/index.ts` 的 `tryListen` 按运行期二选一
  （`Bun.serve`，或 `node:http` 桥接见 `server/src/serve-node.ts`）；
  静态文件一律走 `node:fs/promises`。
  ⚠️ **不要为 Node 另写一套路由** —— 那会产生第二个「什么路径返回什么」的实现，
  两边必然漂移且不会报错。
- **本地库必须保留降级路径**：`openStats()` 在库不可用（磁盘满 / 权限 /
  `SQLITE_CORRUPT` / `SQLITE_BUSY`）时自动回退直扫日志并带 `degradedReason`。
  库是**日志的派生物**，不是真值 —— 为它让页面白屏是不划算的。
- **库坏了就重建，不要写迁移逻辑**：`DB_SCHEMA_VERSION` 不符 → `rebuildSchema()`。
  数据全部可从日志重扫，迁移代码比「重建」更容易出错且更难测试。

## 测试

```bash
bun test                                    # 全仓
bun test packages/shared                    # 单包
bun run --filter '@ai-token-report/server' test
```

- 测试文件与被测代码同包，放 `<pkg>/test/*.test.ts`
- `packages/server/test/e2e-identity.ts` 是**端到端脚本**（`bun run` 执行，非 `bun test`）
- `packages/*/verify/` 下的脚本用于人工验证渲染与图表
- **改口径公式必须同时改 `packages/shared/test/metrics.test.ts`** —— 那里的断言
  固化了 94.3% / 19.3 倍等实测结论，是防止口径漂移的最后一道防线

## 提交前

```bash
bun test && bun run typecheck
```

两者都必须过（`bun test` 全绿 + 7 个包全部 exit 0）。
typecheck 是契约漂移的主要拦截点 ——
前后端字段对不上时它会直接编译失败，而不是等运行时看到空图表。




