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
bun test                        # 29 个文件 / 677 个测试，全绿
bun run typecheck               # 7 个包全部 exit 0
bun run build                   # web-local + web-portal 均构建成功
bun run stats -- --period today # 终端统计（读本地库，热态 ~50ms）
bun run stats -- --period today --no-db   # 直扫日志（与库结果做对照）
bun run web                     # 本地页面（需先 bun run build:local）
bun run --filter '@ai-token-report/server' start   # 部门服务端 → 8787/api/health
bun run dev:local               # web-local 开发服务器
bun run build:portal            # 部门看板构建产物（server 自动托管 packages/web-portal/dist）
bun run dev:portal              # web-portal 开发服务器（5198，/api 代理到 8787）

# 上报链路端到端（真 HTTP，不是 mock；改上报相关代码后全跑）
bun run packages/server/test/e2e-ingest.ts           # 服务端侧 POST /api/v1/token-usage（35 项）
bun run packages/cli/verify/verify-report-ingest.ts  # ④整条链 CLI report → 服务端 → 库（28 项）

# 人员管理与权限端到端（真 HTTP；改 admin 路由 / 凭证文件 / 角色后全跑）
bun run packages/server/test/e2e-admin.ts            # 签发即刻生效 + 401/403 + 护栏（54 项）

# 分发面契约（67 项，含 S12.3 的静态托管断言；改 app.ts / 路由 / 方法 / 状态码后必跑）
bun test packages/server/test/http-contract.test.ts

# 双轨对照验证（真实日志上跑 SQL vs 直扫，断言两者逐位一致）
bun run packages/cli/verify/verify-db-parity.ts

# 双运行时驱动对照（Node 的 node:sqlite vs Bun 的 bun:sqlite，逐行比对）
bun run --filter '@ai-token-report/core' verify:drivers

# MySQL 方言活体验证（17 项；需要本机可连的 MySQL；只建/删 probe_* 探测表）
# 默认连本机开发库（3335 / ai-token），别的机器用 ATR_MYSQL_URL 覆盖
bun run --filter '@ai-token-report/core' verify:mysql

# ★ 双后端逐位对账（53 项；需要本机可连的 MySQL；改上报库 / 看板查询后必跑）
#   同一批数据起两个服务端（SQLite / MySQL），断言看板每个接口的响应体 JSON 全等
bun run packages/server/verify/verify-mysql-portal.ts

# ★ 断言 zod 没进前端产物（S12.5；shared 根入口一旦 re-export schemas 就会变大且不报错）
bun run --filter '@ai-token-report/shared' verify:bundles

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

# 部门看板（S7 + S8）：SSR 真执行组件树，断言门禁页 / 看板区块 / 不出现金额
bun run --filter '@ai-token-report/web-portal' verify
```

✅ 四种形态全部落地。`/api/v1/stats/*` 查询接口（S7）与部门看板页面（S8）
均已实现：上报写 `portal.sqlite`（S3），看板**只读**它，两者是同一条链路的
两端。改看板相关代码后要跑 `packages/server/test/stats-api.test.ts`
（接口与鉴权）、`packages/core/test/portal.test.ts`（查询与人员排行）。

## 目录

| 路径 | 职责 |
|---|---|
| `packages/shared` | **契约单一真源**：上报 DTO、查询响应、口径公式 |
| `packages/core` | **内核**：decode / scanner / aggregate / range / state / format / types / home / identity-store |
| `packages/core/src/db` | ★ **本地 SQLite 增量库**（独立入口 `@ai-token-report/core/db`）：schema / ingest / query / stats / **portal（上报库只读查询）** |
| `packages/cli` | **命令入口**：`cli.ts` / `deliver.ts` / `report.ts` |
| `packages/server` | 上报接收 + 本地直查 + 部门统计 + **人员管理（凭证读写）** + 静态托管 |
| `packages/web-local` | 本地页面（`/api/local/*`） |
| `packages/web-portal` | 部门看板：人员排行 / 趋势 / 分布 / 明细 / 诊断 + **人员管理页（仅管理员）**，数据来自 `/api/v1/stats/*` 与 `/api/v1/admin/members*`（**需身份 token**） |
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
| **权限 / 人员管理 / token 发放** | `packages/server/src/member-admin.ts` + `ARCHITECTURE.md` §4.5.5~§4.5.6 |
| **工程约定**（命令 / 测试位置 / 命名 / 中文注释 / 依赖） | `.agents/skills/repo-conventions/SKILL.md` + `docs/本仓工程约定.md` |
| 目录分工 / 数据通路 | `ARCHITECTURE.md` |
| 插件方案（历史） | `docs/插件方案.md` |
| **DSH 插件**（配置 / 安装 / 排障 / 为什么不能碰私有字段） | `packages/dsh-plugin/README.md` |
| **server 层分层 / 要不要引入第三方库** | `docs/server架构重构方案.md` + `.agents/skills/repo-conventions/SKILL.md` |
| **部门上报库接 MySQL（方言坑 / 部署 / 备份）** | `docs/mysql上报库.md` |

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
- **🚨 角色（`role: admin | member`）是权限的唯一来源**，缺省 `member`。
  **绝不要用姓名白名单判断管理员** —— 姓名是可以随便改的显示值。
  消费方（页面 / 插件）拿到缺字段的校验响应时**必须按 `member` 处理**：
  默认成管理员意味着「服务端少返回一个字段」直接变成「人人可发 token」。
- **🚨 人员管理接口（`/api/v1/admin/members*`）的鉴权失败要分三类**：
  `401`（没带 / token 不对）、**`403`**（token 有效但不是管理员）、
  `503`（服务端没配凭证）。合并成一个状态码，页面就只能说一句含糊的「操作失败」；
  而回 `200 + ok:false` 更糟 —— 响应体里装的是**人员名单与 token**。
  业务失败（重名、最后一个管理员不能删……）才是 `200 + ok:false`。
- **🚨 凭证文件是唯一真值，且有两道不可移除的护栏**（`member-admin.ts`）：
  1. **先落盘、再整体替换内存镜像**（`CredentialStore.replaceAll`）。
     反过来会出现「页面上 token 能用、重启后消失」。
  2. **文件读不懂时拒绝一切写入** —— 拿内存空表覆盖 = 静默吊销全员，
     与「上报库绝不自动重建」同类。
  另有 **最后一个管理员不可删 / 不可降级**（否则没人能再发 token），
  以及**姓名唯一**（看板按姓名分组，同名会被并成一个人且看不出异常）。
- **🚨 全进程只能有一个 `CredentialStore` 实例**（上报 / 看板 / 管理共享）：
  管理页签发的 token 必须**立刻**可用于上报。若各路由各建一份，
  员工拿到 token 后要等服务端重启才生效，而管理员这边一切正常 ——
  排障方向会被完全带偏。`e2e-admin.ts` 钉着这条。
- **冷启动兜底是 `ATR_ADMIN_TOKEN`**（`ATR_ADMIN_NAME` 可选）：
  凭证文件为空（全新部署）或只读（编排系统挂载）时，没有它就没有任何人
  能进管理页 —— 而管理页的第一件事正是发放第一个 token。**它不落文件**。
- **看板的人员筛选是精确匹配、可多选**（`?user=张三,李四`）；
  provider / model 才是子串匹配。页面上的**人员候选必须用不含人员筛选的
  同窗口查询**取回：从已筛选结果里取候选，选中一个人之后下拉会塌缩成一个选项
  （自锁定），使用者再也加不回别人，而页面看起来像「其余人都没数据」。
- **不展示金额**（已确认决策）：无单价来源，只展示 token 数。
- **解析失败要降级不要抛错**：身份文件 / 凭证文件损坏时降级为「未配置」并告警，
  抛错会让页面白屏或服务起不来。
- **`Bun.serve` 必须显式设 `idleTimeout`**：默认 10 秒太短 —— 首次冷建库
  要约 15 秒，客户端会看到 `ECONNRESET` 而**服务端一条日志都没有**。
  已在 `server/src/runtime/listen.ts` 设为 120 秒，改动此处前先读那段注释。
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
  最外层由 `server/src/runtime/listen.ts` 的 `tryListen` 按运行期二选一
  （`Bun.serve`，或 `node:http` 桥接见 `server/src/serve-node.ts`）；
  静态文件一律走 `node:fs/promises`。
  ⚠️ **不要为 Node 另写一套路由** —— 那会产生第二个「什么路径返回什么」的实现，
  两边必然漂移且不会报错。
- **🚨 server 的路由与中间件只在 `server/src/app.ts` 一份**（S12 起用 Hono，4.13.9 精确锁版）。
  改任何路径 / 方法 / 状态码，先跑 `packages/server/test/http-contract.test.ts`
  （67 项契约断言，重构前 `bun test` 完全不覆盖分发面）。
  四条实测踩出来的坑，改这里之前必读 `app.ts` 的注释：
  1. **Hono 不做 405**，方法不匹配默认回**纯文本 404**且无 `Allow` ——
     405 靠 `hono/method-not-allowed` 读 `app.routes` 反查；
  2. **兜底必须 `app.use('*')`，绝不能 `app.get('*')`** ——
     后者作为 GET 路由登记后，`method-not-allowed` 会认为任何路径都允许 GET，
     于是「只收 POST」的端点永远拿不到 405，而未注册路径反而回 `405 + Allow: GET`；
  3. `method-not-allowed` 会把 **HEAD 并进 GET**，而本仓契约是
     `Allow` **恰好列出真实处理器**（`e2e-ingest.ts` 逐字断言），故要滤掉 HEAD；
  4. **`/api/*` 未命中一律 JSON 404**：静态兜底若把它接过去会回 200 + HTML，
     前端会渲染成「数据通道没装上」（`dsh-plugin/test/client/usage-store.test.ts:137`）。
- **鉴权的状态码映射只有一处**：`server/src/http/auth.ts` 的 `authorize()`
  （401/503 + 管理员 403，顺序是「先认人、再认角色」）。
  角色缺省 `member` 只在 `verify-route.ts` 的 `viewerFrom()` 里写一次 ——
  改动这两处等于动「谁能进管理页」。
- **请求体上限与 JSON 读取只有一处**：`server/src/http/body.ts`
  （`strict` = 空 body 也算非法，用于上报/署名；`lenient` = 空 body 合法，
  用于人员管理）。32 MiB 是**刻意给足**的：被挡下的批次会在客户端无限重试。
- **🚨 `zod` 只准从 `@ai-token-report/shared/schemas` 子路径进**（S12.5）：
  `packages/shared/src/index.ts` **绝不 re-export** schemas —— 根入口要同时跑在浏览器、
  Bun 与插件进程里，一旦 re-export，zod 会进 `web-local` / `web-portal` / 插件浏览器半的产物
  （**只会变大，不会报错**）。新增跨包 import 记得在各包 `tsconfig.json` 的 `paths` 里补一条。
  准入断言：`bun run --filter '@ai-token-report/shared' verify:bundles`。
  另：**查询参数解析仍手写**（`stats-route` / `local-api`），不要顺手 schema 化 ——
  那几处的文案与「非法值不许静默当成没给」的语义被逐字断言钉着。
- **部门上报库可选 MySQL；本机库 `usage.sqlite` 恒为 SQLite**：
  本地路径的函数只收**同步 SQLite `Database`**，MySQL 侧只有异步 `PortalStore` ——
  「员工机器上跑 CLI 要有 MySQL」这件事**在类型上就不可能**。Node 上配 MySQL 会
  明确报错（Node 无内建 MySQL 客户端，而 npm 版 CLI 只跑本机库，不为用不到的通路引依赖）。
  详见 `docs/mysql上报库.md`。
- **🚨 MySQL 有三处「静默语义变化」的方言坑**（都在 `core/src/db/dialect.ts` 收口，
  改 SQL 前必读）：
  1. `a || b` 在 MySQL 是**逻辑或**，`provider || '/' || model` 会返回 `0`/`1` ——
     分组键悄悄变成两行垃圾数据。必须走 `dialect.concat()`。
  2. `SUM(BIGINT)` 经驱动返回**字符串** `"60"`（`COUNT(*)` 是数字）——
     未归一会让看板数字变 `NaN`/字符串拼接。归一只能在口径边界 `portal.ts` 的 `num()`。
  3. `key` 是 MySQL **保留字**（`AS key` 语法错误）→ 分组别名统一 `grp_key`，
     TS 侧映射回 `key`（对外契约不变）。
  另有两条会报错的（好抓）：标量最大值 `MAX(a,b)`→`GREATEST(a,b)`；
  `INSERT OR IGNORE`→`INSERT IGNORE`、`ON CONFLICT…excluded`→`AS new ON DUPLICATE KEY UPDATE…new`。
- **🚨 `toPositional()` 的参数表键名带 `$`**：`query.ts` 的 `buildWhere()` 产出的是
  `params['$since']`，翻译成 `?` 时必须用**带前缀的原始键**查表 ——
  写成剥掉 `$` 的名字会让**每一句真实 SQL 都抛「参数缺失」**（这个 bug 被活体脚本抓到过）。
- **MySQL 侧 `close()` 是空操作**（连接来自进程内共享池，每请求关池 = 每请求重新
  握手）。上层照常 `finally { await store.close() }`，两种后端形状一致。
- **上报库的 schema 变更绝不能自愈**：SQLite 与 MySQL 两条路都在版本不符时**抛错**
  （`portal-db.ts`），绝不重建、绝不 drop —— 它是全员数据的唯一副本。
- **本地库必须保留降级路径**：`openStats()` 在库不可用（磁盘满 / 权限 /
  `SQLITE_CORRUPT` / `SQLITE_BUSY`）时自动回退直扫日志并带 `degradedReason`。
  库是**日志的派生物**，不是真值 —— 为它让页面白屏是不划算的。
- **本地库坏了就重建，不要写迁移逻辑**：`DB_SCHEMA_VERSION` 不符 → `rebuildSchema()`。
  数据全部可从日志重扫，迁移代码比「重建」更容易出错且更难测试。
- **🚨 上报库（`portal.sqlite`）是唯一副本，绝不自动重建**：它由
  `openPortalDb()` 打开，schema 版本不符时**抛错**（不是 `rebuildSchema`）。
  客户端投递成功后已清掉自己的 pending / outbox，删掉 = 全员历史用量永久消失。
  同一份 schema 在本地走 `openDatabaseForIngest()`（可重建）、
  在服务端走 `openPortalDb()`（不可重建），**两个入口不能混用**。
  上报库还必须与本地库 `usage.sqlite` 分开：混用后无法事后拆开。
- **🚨 `server/src/serve-node.ts` 必须动态 `import('node:http')`**：
  它在被求值的那一刻就构造 `http.globalAgent` 并解析 `HTTP_PROXY`，
  环境变量里只要有一个非法值（实测：末尾带 CRLF 的 `HTTP_PROXY`）就抛
  `ERR_PROXY_INVALID_CONFIG` —— 静态 import 会让**跑在 Bun 上的服务端也起不来**，
  且崩在 import 阶段、没有任何启动日志。Node 适配器的依赖不该在 Bun 上被求值。
- **🚨 上报接口的鉴权失败必须是非 2xx**（`401` / 未配置凭证时 `503`），
  **不能学 `/api/v1/identity/verify` 的 `200 + ok:false`**：客户端把 2xx 当作
  「已投递」并清掉 pending，回 200 等于把那批用量静默丢掉。
- **上报的归属只信服务端**：`client.userName` 一律忽略，只取
  `Authorization` 头查凭证表的结果（`user_id/user_name/dept` 三列）。
  同一条记录被两个上报方上报时，归属以**先到的**为准（主键冲突整行不写）。
- **🚨 看板接口（`/api/v1/stats/*`）的鉴权失败也必须是非 2xx**（`401` /
  未配置凭证时 `503`）。理由与上报不同但同样硬：它的响应体里装的是**数据**，
  回 `200 + ok:false` 会让前端把「token 不对」渲染成「这段时间没人用」——
  一个 0 值空看板比一个明确的 401 危险得多。
- **🚨 看板只读上报库，`stats-route.ts` 不写一个字节**。它由
  `openPortalStats()`（内部走 `openPortalDb()`）打开，schema 版本不符时
  **抛错而不是重建**；这里**没有降级直扫这条退路** —— 上报库没有可重扫的真值。
- **未归属只有一种表述**：库里是 `user_id IS NULL`，对外一律用
  `shared` 的 `UNATTRIBUTED_USER`（`'unknown'`）。分组键用
  `COALESCE(user_id, 'unknown')`，筛选值同为 `'unknown'` —— 两处一旦不同值，
  「点开未署名」会得到 0 行且**没有任何报错**。
- **按人筛选是精确匹配，provider/model 才是子串匹配**。人名做子串会把
  「张三」和「张三丰」并成一个人 —— 那是数据错误，不是便利。
- **`user` 维度只存在于查询层**（`core/db/query.ts` 的 `QueryDimension`），
  **不要并进 `aggregate.ts` 的 `GroupDimension`**：后者是内存聚合（直扫日志）
  的维度集合，而日志里根本没有归属，塞进去只会多一个恒为 `unknown` 的选项。
- **看板前端不得重算任何口径**（同浏览器半那条）。页面上的算术只有两处，
  且都只是排版、不参与数字展示：排行条的宽度比例，以及图表里「值 → 像素」
  的换算（由 Chart.js 完成）。
- **趋势图用 Chart.js 4**（`web-portal/src/components/trendChartConfig.ts`），
  与 DSH 插件界面同一个库。两条容易踩的：canvas **不认 `var(--c-chart-*)`**，
  颜色必须先经 `readTrendChartTheme()` 解析；悬浮提示靠
  `interaction: { mode: 'index', intersect: false }`，少了它就退化成
  「必须精确压中柱子」—— 改完跑 `bun run --filter '@ai-token-report/web-portal' verify:charts`。
- **看板的时间窗默认传具名周期（`period`）**，由服务端用 `core/range.ts`
  解析。前端自己算「本月从哪天开始」= 把时区口径复制到第二个地方。
  **唯一的例外是「自定义区间」**：它传显式的 `from` / `to`（epoch 毫秒），
  因为那本来就是使用者选定的两个绝对时刻（`datetime-local` 给的就是本地墙上时间），
  不是任何口径；两者**不能同时发**（`period=custom` 会被服务端当成未知周期而 400）。
- **上报库没有 `total_tokens` 列**（铁律 2），所以诊断里的
  `identityViolations` **结构性恒为 0** —— 文案不能说成「扫了 N 条都没问题」，
  那是把一个恒真值伪装成检查结果。

## 测试

```bash
bun test                                    # 全仓
bun test packages/shared                    # 单包
bun run --filter '@ai-token-report/server' test
```

- 测试文件与被测代码同包，放 `<pkg>/test/*.test.ts`
- `packages/server/test/e2e-identity.ts` / `e2e-ingest.ts` / **`e2e-admin.ts`** 是**端到端脚本**
  （`bun run` 执行，非 `bun test`）；`e2e-admin.ts` 覆盖人员管理全链路
  （签发即刻可上报、401/403 分开、最后一个管理员护栏、坏文件拒绝写入）
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




