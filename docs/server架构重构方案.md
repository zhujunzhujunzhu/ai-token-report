# server 层技术架构梳理与「库化」重构方案

> 本文回答一个问题：**`packages/server` 哪些代码该继续自己写，哪些该换成成熟库，怎么换才不把本仓的护栏换没。**
>
> §1 是**重构前**的体检快照（行号对应改造前的代码，保留下来是为了让后来人
> 知道「为什么当时要动」）；§2~§3 是目标与选型；§4 是分阶段方案与**落地状态**；
> §5 是迁移红线；§6 是风险。
>
> ## 落地状态（2026-09 实测）
>
> | 阶段 | 内容 | 状态 |
> |---|---|---|
> | **S12.0** | 补分发面契约测试（`test/http-contract.test.ts`，41 项）+ 修 3 个小瑕疵 | ✅ 已落地 |
> | **S12.1** | `hono` 接管路由（185 行 `if` 链 → 路由表 + 中间件） | ✅ 已落地 |
> | **S12.2** | 中间件收编（统一鉴权 / 错误信封 / body 上限 / 日志 / request-id / 安全头） | ✅ 已落地 |
> | **S12.4** | 孤儿子系统裁定 → **按「删除」执行**（843 行源码 + 4 个测试文件已删）；⚠️ 见 §1.4 的后续：该能力后续被**另一条工作线**以登录功能重新实现 | ✅ 已落地 |
> | **S12.3** | 静态托管升级（ETag / 304 / `Cache-Control` / gzip / `HEAD` / 容器校验） | ✅ 已落地 |
> | **S12.5** | schema 化（`zod`，放 `shared` 子路径导出、**不进前端 bundle**） | ✅ 已落地 |
>
> **验收（全部 exit 0）**：
>
> ```
> bun test                                     557 pass / 0 fail / 25 files
> bun run packages/server/test/e2e-identity.ts 27 项通过，0 项失败
> bun run packages/server/test/e2e-ingest.ts   35 项通过，0 项失败
> bun run packages/server/test/e2e-admin.ts    54 项通过，0 项失败
> bun run build:npm:cli && bun run verify:npm:cli   双运行时（Node + Bun）全绿
> bun run typecheck                            6/7 包 exit 0（web-portal 失败见 §6「已知问题」）
> ```
>
> ⚠️ **两处与原方案的偏离，都是实测逼出来的**（细节见 §3.5 与 §4 的「实测发现」）：
> 1. **没有引入 `@hono/node-server`** —— 实测它在 Bun 上 import 即崩（本机 `HTTP_PROXY` 带 CRLF）；
>    原有的 `serve-node.ts` 保留（184 行，已处理 EADDRINUSE 异步 reject 与 `requestTimeout`）。
> 2. **405/Allow 不自己写** —— Hono 自带 `hono/method-not-allowed`，读 `app.routes` 反查，
>    比原计划的手写路由表更干净。

---

## 0. 一句话结论

server 层重构前是 **4 557 行零第三方依赖的手写实现**，其中约 **275 行**是
「路由分发 + 中间件」这类**本该由框架承担**的机械动作，而真正值钱的业务护栏
（凭证唯一真值、401/403/503 三分、上报非 2xx…）反而被淹没在同一批文件里。

**结论（已执行）：引入 `hono`（4.13.9，MIT，**0 依赖**）接管「HTTP 机械动作」，
把业务护栏留在自己的代码里并用契约测试钉住。**
其余候选（校验、限流、哈希、验证码、ORM）逐项在 §3 给出「换 / 不换 / 暂缓」的判定 ——
其中**验证码是刻意不该换的**（那一份孤儿实现已删除；后来按本文选型重建成了登录功能，
见 §1.4），理由见 §3.6。

---

## 1. 现状体检（事实）

> ⚠️ **本节是重构前的快照**：行号与「生产调用方」列描述的是 S12 落地**之前**的代码
> （`index.ts` 680 行、`if` 链 185 行、孤儿子系统尚在）。
> 落地后的真实布局见 §2.2；本节保留下来是为了回答「当时为什么必须动」。

### 1.1 家底

| 文件 | 行数 | 自研程度 | 生产调用方 |
|---|---|---|---|
| `index.ts` | 680 | 路由分发 + 静态托管 + body 读取，全手写 | 所有形态的入口 |
| `member-admin.ts` | 524 | 纯自研：token 生成 + 原子写 + 全部业务护栏 | `index.ts:207-240` |
| `stats-route.ts` | 447 | 薄路由 + 手写查询参数校验 | 看板 |
| `local-api.ts` | 397 | 薄路由 + 手写参数校验 | 本地页 |
| `credentials.ts` | 357 | 纯自研：双格式解析 + 明文查表 | `index.ts:215`（三路由共享） |
| `ingest-route.ts` | 299 | 薄路由 + 手写逐行校验 | 插件 / CLI 上报 |
| `captcha.ts` | 288 | 纯自研绘图 | **仅测试**（见 §1.4） |
| `password.ts` | 246 | 自研 PHC 层（KDF 用 `node:crypto`） | **仅脚本**（见 §1.4） |
| `main.ts` | 230 | CLI 入口 | 部署入口 |
| `admin-route.ts` | 218 | 薄路由 | 管理页 |
| `png.ts` | 205 | **完全从零**：PNG 编码器 + CRC32 + Bresenham | `captcha.ts` |
| `identity-route.ts` | 203 | 薄封装（落盘委托 `core`） | 本地页 |
| `serve-node.ts` | 184 | `node:http` → `Request/Response` 桥接 | Node 运行时 |
| `verify-route.ts` | 175 | 薄层：Bearer 解析 + 身份解析 | 四条路由 |
| `dot-font.ts` | 104 | **完全从零**：32 个 5×7 手写字模 | `captcha.ts` |
| `scripts/hash-password.ts` | 156 | 薄脚本 | `package.json` script |

`src/*.ts` 合计 **4 557 行**。运行时依赖只有两个 workspace 包；
**第三方运行时依赖为 0**（根 `package.json` 连 `dependencies` 字段都没有）。
`bunfig.toml` 是 `exact = true`，新增依赖会锁精确版本。

**基线（本方案写作时实测）**：

```
bun test          → 557 pass / 0 fail / 2113 expect() calls / 28 files   (exit 0)
bun run typecheck → 7 个包全部 exit 0
```

### 1.2 路由分发：185 行 `if` 链

`createHandler`（`index.ts:377-581`）是唯一入口，纯分发体 `390-574`：

| 行 | 路径 | 匹配 | 方法 |
|---|---|---|---|
| 397 | `/api/v1/token-usage` | `===` | POST |
| 415 | `/api/v1/identity/verify` | `===` | POST |
| 439 | `/api/v1/stats/` | `startsWith` | GET |
| 452 | `/api/v1/admin/members[/...]` | `===` + `startsWith` | GET/POST + 子动作 |
| 494 | `/api/local/identity` | `===` | GET/POST/DELETE |
| 519 | `/api/local/stats/` | `startsWith` | GET |
| 540 | `/api/local/refresh` | `===` | POST |
| 546 | `/api/health` | `===` | 任意方法（无校验） |
| 560 | 其余 GET | 兜底 | 静态 / SPA 回落 |

没有路由表、没有路径参数、没有中间件管道。`405` 只有一个 helper
（`index.ts:671-676`）但有 **8 个调用点**；`404` 有 **6 个来源**
（`index.ts` 4 处 + `stats-route.ts:125,157`）。

### 1.3 四个结构性问题

**① 鉴权语义重复，且与本仓「唯一实现」哲学自相矛盾。**

`registered ? 401 : 503` 这段映射写了 **3 遍**（`ingest-route.ts:109`、
`stats-route.ts:119`、`admin-route.ts:173`，admin 另加 `403` @ `:180`）。
`resolveIdentity`（`verify-route.ts:149-174`）的注释自称：

```
 * 身份解析的**唯一实现**。
 * … 若各写一份，「token 有效性判定」就有两个实现，
 * 而其中一个松一点的那个不会报错，只会让不该进来的人进来。
```

但它旁边就有一个**同构的第二份** `verifyToken`（`:62-96`），
两者共享 `tokenFromHeader` 却各自走一遍三态分支（只为返回不同形状）。
——这正是本仓最忌惮的「同一判定、两处实现」，只是它还没咬人。

**② 错误信封手写 31 次。** `{ ok: false, reason }` 以字面量出现在 5 个文件里
（`index.ts` 12 处、`stats-route.ts` 12 处、`ingest-route.ts` 3 处、
`local-api.ts` 2 处、`admin-route.ts` 2 处），没有 `error.code`。

**③ 典型中间件四缺三。** 请求日志：**零**（`src/` 里 `console.*` 零命中，
请求路径上唯一的输出是 `index.ts:220` 的凭证加载失败告警）；CORS：**零**；
入站 `Content-Type` 校验：**零**；body 上限：只有上报有
（`MAX_INGEST_BODY_BYTES` 32 MiB，`index.ts:116,400`），
`/api/v1/admin/members*`、`/api/v1/identity/verify`、`/api/local/identity` 都没有。

**④ body 读取有 4 条路径，其中 1 条静默吞错。** `index.ts:404` /
`:418-424`（`verify`：非法 JSON **静默忽略**，改看 `Authorization` 头）/
`:499` / `:589-597`（`readJsonBody`，仅 admin 用）。

### 1.4 一段 843 行的「孤儿子系统」

`password.ts`(246) + `captcha.ts`(288) + `png.ts`(205) + `dot-font.ts`(104)
= **843 行源码 + 616 行测试**（`password.test` 212 / `captcha.test` 159 /
`png.test` 169 / `dot-font.test` 76），但：

- **没有任何 HTTP 路由引用它们**（全仓无 captcha 路由、无登录路由）；
- `passwordHash` 这个字段在 `credentials.ts` 的解析器里**都不存在**，
  `shared/protocol.ts` 与任何 `docs/` 也没提过；
- 唯一的生产调用方是 `scripts/hash-password.ts`（它生成的值没人读）；
- `password.ts` 的注释反复提到「登录路由」「校验端（登录路由）」——
  那个路由从来不存在。

这是一条**封闭孤岛**：能测、能生成、能吃哈希，但没人接线。

> ✅ **S12.4 已按「删除」执行**（`src/{password,captcha,png,dot-font}.ts` +
> `test/{password,captcha,png,dot-font}.test.ts` + `scripts/hash-password.ts` +
> `package.json` 的 `hash-password` script 全部移除，`tsconfig` 的 `scripts/**` 一并去掉）。
> 理由：零调用方 + 零接线 = 纯维护成本与「看起来能用」的错觉；需要时 git 历史可查，
> 重建路径见本文件 §4 的 S12.4 表（`@noble/hashes` + `hono/cookie` + 限流）。
>
> ⚠️ **后续（同一时期的另一条工作线）**：看板「密码 + 验证码登录」被重新实现，
> 落在 `packages/server/src/auth/{portal-auth,captcha,password}.ts`，
> 并用了 `@noble/hashes` 与 `rate-limiter-flexible` —— 与本表选 B 时给出的选型一致。
> 也就是说「删除」这个决定的**结论仍然成立**：那次删的是**没人调用的那一份**；
> 真正需要它时，是按 §3.6 与 §4 的选型**新建**的，而不是把旧代码留着。
> 那部分代码与路由归该工作线负责，本文不再描述其内部实现。
>
> ⚠️ 唯一不可丢的约束仍然成立：**验证码答案只能以像素存在**（不能返回 SVG/文本），
> 这也是它「不该换库」的原因（§3.6）。

### 1.5 静态托管：52 行，缺的正是最该有的

`index.ts:559-572` + `serveStatic` `:616-635` + `contentTypeOf` `:637-645`
+ `readFileOrNull` `:605-613`。有 `..` 拦截与非法百分号编码 400
（`e2e-identity.ts:169-175` 钉着），但**没有** ETag、`Cache-Control`、
gzip、`Last-Modified`、`Range`、`HEAD`（HEAD 不满足 `req.method === 'GET'`，
落到 JSON 404）。MIME 表手写 6 项。SPA 回落每次重读 `index.html`，无缓存。

⚠️ **一个未被任何注释或测试指出的行为**：静态块对所有 GET 生效，
`GET /api/不存在的路径` 会拿到 **200 + text/html**（不是 JSON 404）。
这不是理论风险 —— 前端已经踩过：

```
packages/dsh-plugin/test/client/usage-store.test.ts:137
  test('200 但响应体不是 JSON（SPA 兜底返回了 HTML）', …)
```

### 1.6 测试资产与覆盖盲区

- `bun test`（9 个文件 / 171 个 `test`）：**全部直接实例化路由类**
  （`new StatsRoute(...)` / `new IngestRoute(...)` / `new AdminRoute(...)` /
  `new LocalStatsRouter(...)`），**没有一个调用 `createHandler`**。
- 真 HTTP 只有三个 `bun run` 的 e2e 脚本：`e2e-ingest.ts`(35 项)、
  `e2e-admin.ts`(54 项)、`e2e-identity.ts`(27 项)。
- 因此 `bun test` 范围内**不覆盖**：路径分发本身、`405` + `Allow` 头、
  `413`、静态托管、SPA 回落、`/api/health`、`serve-node.ts` 适配器。
- `packages/server/verify/` 目录不存在。

**这是重构前必须补的网**：路由改造的最大风险不是「改错」，而是
「路由表写得看起来对，但某个方法/状态码悄悄变了而没人发现」。

### 1.7 顺手发现的三个小瑕疵（与库无关，但该修）

1. `credentials.ts:39` 文档写「路径：`ATR_CREDENTIALS` 环境变量」，
   而全仓**从未读取**该变量（实际只有 `--credentials` 旗标与默认值）。
2. `identity-route.ts:199-201` 把超时文案硬编码成 `请求超时（8s）`，
   而超时值来自可配置的 `verifyTimeoutMs` → 文案可能与实际不符。
3. 文档基线漂移：`AGENTS.md` 写「28 个文件 / 557 个测试」（与实测一致），
   而 `docs/本仓工程约定.md` §7 仍写「168 pass / 7 files」。

---

## 2. 目标分层

### 2.1 一条原则

> **库接管「HTTP 机械动作」，业务护栏留在自己手里。**
>
> 判据：这段代码换掉之后，**会不会有人因为「不该进来的人进来了」或
> 「该报的错没报」而查不出原因？** 会 → 不交给库。

按这条线切，`index.ts` 的 680 行会分成两堆：

| 关注点 | 现在 | 目标 | 归属 |
|---|---|---|---|
| 路径/方法分发 | `if` 链 185 行 | `app.get/post` 路由表 | **库** |
| Bearer 解析 | `tokenFromHeader` | `hono/bearer-auth` 或保留（见 §5 红线 4） | 库 + 自持 |
| 401/403/503 判定 | 3 处各写一遍 | 一个 `auth` 中间件 | 自持（语义） |
| 错误信封 `{ok:false,reason}` | 手写 31 次 | 一个 `fail()` + `app.onError` | **库**（管道）+ 自持（文案） |
| body 读取 / 上限 | 4 条路径，1 处静默 | `readJson` + `bodyLimit` 中间件 | **库** |
| 请求日志 / request-id | 无 | `hono/logger` + `hono/request-id` | **库** |
| 安全响应头 | 无 | `hono/secure-headers` | **库** |
| CORS | 无 | `hono/cors`（默认**关**） | 库 |
| ETag / 压缩 | 无 | `hono/etag` + `hono/compress` | **库** |
| 静态文件 | 52 行手写 | `serveStatic` + 一份 SPA 回落语义 | **库** |
| 入参校验 | 手写 `typeof` | `zod` schema（阶段 S12.5） | 库 |
| 405 + `Allow` | 1 helper / 8 调用点 | Hono 自带（**必须断言 `Allow` 仍在**） | 库 |
| 静态资源 MIME | 手写 6 项 | `serveStatic` 自带 | 库 |
| **凭证唯一真值 / 唯一实例** | `credentials.ts` | 不动 | **自持** |
| **先落盘再整体替换内存** | `member-admin.ts` | 不动 | **自持** |
| **最后管理员 / 姓名唯一 / env 管理员** | `member-admin.ts` | 不动 | **自持** |
| **上报非 2xx、看板非 2xx、verify 恒 200** | 四条路由 | 不动（但收敛到一处判定） | **自持** |
| **归属只信服务端** | `credentials.ts:165-191` | 不动 | **自持** |
| **口径不在 SQL 里** | `core/db` | 不动 | **自持** |

### 2.2 落地后的实际布局（与「目标目录」的差异一并说明）

```
packages/server/src/
  app.ts                 ★ 唯一路由真源：new Hono() + 中间件 + 路由表 + 兜底
  index.ts               ★ 只剩组装：选项 → 依赖链 → 起监听（~270 行，原先 680）
  main.ts                CLI 入口（未改）
  runtime/
    listen.ts            DEFAULT_PORT / IDLE_TIMEOUT_SECONDS / tryListen / 端口重试
  http/
    envelope.ts          json / fail / methodNotAllowed / respond —— 唯一的错误信封
    auth.ts              authorize()：401/403/503 + 管理员门的**唯一**实现
    body.ts              requestBodyLimit() + readJsonBody{Strict,Lenient}
    static.ts            serveStatic / readFileOrNull / contentTypeOf（未增强，见 S12.3）
  domain（业务与护栏，不改语义）
    credentials.ts  member-admin.ts  verify-route.ts  identity-route.ts
    ingest-route.ts  stats-route.ts  admin-route.ts  local-api.ts
  serve-node.ts          Node 适配器 —— **保留**（原因见 §3.5）
```

与原目标的三处差异，都是实现时改的，各有理由：

| 原计划 | 实际 | 理由 |
|---|---|---|
| `runtime/node-adapter.ts` 换成 `@hono/node-server` | **保留 `serve-node.ts`** | 实测该库在 Bun 上 import 即崩；且它不提供 EADDRINUSE 的异步 reject（端口重试依赖它） |
| `routes/*.ts` 六个文件 | **都留在 `app.ts`** | 6 个 handler 合计约 180 行、共享同一个 `AppDeps`；拆开只是把依赖传来传去、把端点清单打散 |
| `http/static.ts` 顺手加 ETag/Cache-Control | **只搬不改** | 静态语义与路由改造混在一起会让问题无法分开定位 → 归到 S12.3 |
| `auth.ts` 做成 Hono 中间件（`c.set('viewer')`） | **做成 `authorize()` 函数，由路由类调用** | 中间件版要求改路由类的公开签名，而它们的单测直接调用这些签名（`new StatsRoute(...)`）—— 为「换个调用姿势」去改 171 个测试的接缝不划算 |

**关键接缝确实存在**：四个路由类本来就是纯 `{ status, body }` 形状，
由 `respond()` 转成 `Response`。它们**不接触 `Request`/`Response`**，
也不依赖任何运行时专有 API（`node:fs` / `node:crypto` / `node:zlib` 在 Bun 与 Node 上都有）——
所以本次改造里 **domain 一行语义都没改**，只把「算状态码」换成调用 `authorize()`。

---

## 3. 选型

### 3.1 主选：Hono 4.13.9 + @hono/node-server 2.1.1

| 包 | 版本 | 许可 | 依赖数 | 版本数（发布活跃度） |
|---|---|---|---|---|
| `hono` | 4.13.9 | MIT | **0** | 451 |
| `@hono/node-server` | 2.1.1 | MIT | **0** | 101 |

**决定性理由（本仓专属）**：Hono 的入口形状**就是** `(req: Request) => Response`，
与本仓 `createHandler` 的签名逐字相同（`index.ts:377`、
`serve-node.ts:53` 的 `RequestHandler`）。这意味着：

- 硬约束「服务端不得依赖 `Bun.serve` / `Bun.file()`，npm 版 CLI 要跑在 Node 上」
  **零妥协** —— 不需要为 Node 另写一套路由（那是本仓明令禁止的第二个实现）；
- `Bun.serve({ fetch: app.fetch })` 与 `serve({ fetch: app.fetch })`
  只是把最外层换成官方适配器，`tryListen` 的二选一形状可以原样保留；
- 0 依赖，`exact = true` 下锁版本，供应链面最小。

官方文档：[hono.dev](https://hono.dev)、[Node.js 适配（`@hono/node-server`）](https://hono.dev/docs/getting-started/nodejs)。
版本事实来自 `bun info`（本机实测，非文档转述）。

### 3.2 为什么不选别的框架

| 候选 | 不选的理由 |
|---|---|
| Express / Koa | `(req, res)` 是 **Node 专有对象**，与本仓「处理器必须是 Web 标准」冲突；等于给 Node 写第二套路由 |
| Fastify | 同上（`reply`/`request` 自有对象模型），且 schema/插件体系侵入性强 |
| itty-router | 够轻，但中间件生态薄，等于还要自己补 logger/etag/compress |
| 继续手写 | 见 §1.2/§1.3：分发 185 行 + 信封 31 处 + 鉴权 3 份，且缺 4 类基础设施 |

### 3.3 校验：zod 4.6.5（放 `shared` 的子路径导出）

| 候选 | 版本 | deps | 说明 |
|---|---|---|---|
| `zod` | 4.6.5 | 0 | ★ 推荐。生态最全（`@hono/zod-validator` 0.9.1 / `@hono/zod-openapi` 1.6.3），v4 可用 `zod/mini` 控体积 |
| `valibot` | 1.5.0 | 0 | 备选。tree-shaking 更友好，体积更小；生态略薄 |
| `@sinclair/typebox` | 0.34.52 | 0 | JSON Schema 优先时才划算 |
| `@deepseek-ai/schemastery` | 仓内已有（`dsh-plugin`） | — | ⚠️ 不推荐给 server：那是插件配置的 schema 方言，钳到 HTTP 契约上会把两套校验语义绑在一起 |

🚨 **放哪里是关键**：`shared` 的硬约束是「不得依赖任何运行时」——
zod 是纯 JS、零依赖、无 Node/Bun 专有 API，**不违反**这条；
但它会传染给前端 bundle。做法：

```
packages/shared/src/schemas.ts          # 新增，只有 server（与需要校验的消费方）import
packages/shared/package.json  exports:
  "."          → ./src/index.ts          # ★ 根入口不 re-export schemas
  "./schemas"  → ./src/schemas.ts        # 新增子路径
```

这样 `web-local` / `web-portal` / 插件浏览器半 import `@ai-token-report/shared`
时，**一个字节的 zod 都不会进它们的产物**。

### 3.4 中间件清单（全部 Hono 内置，0 新依赖）

**已落地（`app.ts` 的 `app.use` 顺序即语义）**：

```ts
requestId()        // 1) 最先：后面所有日志与错误都带上它
methodNotAllowed() // 2) 405 + Allow，读 app.routes 反查
logger()           // 3) 访问日志（⚠️ 只记方法/路径/状态/耗时；token 在头里，绝不落日志）
secureHeaders()    // 4) 安全响应头（默认不含 CSP —— 静态 SPA 加默认 CSP 会挡内联样式/脚本）
bodyLimit()        // 5) 请求体上限，在解析之前拦下
```

| 中间件 | 用途 | 状态 |
|---|---|---|
| `hono/request-id` | 排障关联（回写 `X-Request-Id`） | ✅ 已接 |
| `hono/method-not-allowed` | **405 + `Allow`**，读 `app.routes` 反查 | ✅ 已接 |
| `hono/logger` | 补上「请求路径零日志」 | ✅ 已接（可用 `requestLog:false` 关掉） |
| `hono/secure-headers` | `X-Content-Type-Options` / `X-Frame-Options` 等 | ✅ 已接 |
| `hono/body-limit` | 统一 32 MiB 上限 | ✅ 已接（用 `onError` 换成我们的信封） |
| `hono/etag` | 304 | ✅ 已接（**只对非 `/api/*`**，见 `staticOnly()`） |
| `hono/compress` | gzip | ✅ 已接（同上；`/api/*` 加压缩会给已钉死的契约加变量） |
| `hono/cors` | 跨域 | ❌ **刻意不接**：本仓 server 自己托管 `dist`，同源；开了只是多一个暴露面 |
| `hono/timeout` | 显式长超时 | ⚠️ 值必须 ≥ `IDLE_TIMEOUT_SECONDS`(120s)，见红线 7 |
| `hono/bearer-auth` | Bearer 解析 | ⚠️ **不要直接用**，见红线 4 |

### 3.5 静态托管：本次**不换**（原计划要换，实测后撤回）

原计划是「两个叶子实现（Node 用 `@hono/node-server/serve-static`、Bun 用
`hono/bun` 的 `serveStatic`）+ 一份共享语义」。**实测后撤回**，理由是硬事实：

| 事实 | 影响 |
|---|---|
| 🚨 `@hono/node-server` 在 **Bun 上 import 即崩** —— 它静态 import `node:http`，求值时会构造 `http.globalAgent` 并解析 `HTTP_PROXY`，本机该变量末尾带 CRLF → `ERR_PROXY_INVALID_CONFIG`，**整个进程死在 import 阶段、没有一行日志** | 与 `serve-node.ts` 文件头记的那个坑是同一个（本机实测复现）。要用它就必须在任何运行期判断**之前**动态 import —— 而那时已经来不及区分运行时了 |
| 它不提供 EADDRINUSE 的**异步 reject** | `serveWithPortRetry` 的重试循环依赖这个语义；`serve()` 返回后端口冲突只会变成一次未捕获的 error 事件 |
| `requestTimeout` / `headersTimeout` 要自己再设一遍 | 而这两个值的存在本身就是「冷建库 15 秒」这条实测结论的产物 |

**保留 `serve-node.ts`（184 行）**：它已经正确处理了上面三件事，且**零行为变化**。
代价是少了一个「上游维护的适配器」——但那 184 行是 `Request`/`Response` 的纯翻译，
升级压力极小。真正有维护价值的部分（路由、中间件、405、body 上限）已经全部交给 Hono。
静态读取也继续用 `node:fs/promises` 一份实现（`http/static.ts`），与 S12.3 的增强一起做。

> 结论归档：**不是所有位置都值得换库**。这一条与 §3.6 的验证码（已随孤儿模块删除）
> 是同一类判断 —— 判据是「换掉之后，故障模式是变清楚了还是变模糊了」。

### 3.6 逐项判定：换 / 不换 / 暂缓

| 候选 | 判定 | 理由 |
|---|---|---|
| `pino` 10.3.1（11 deps） | **暂缓** | 先把 `hono/logger` 用上就能消掉「零日志」这个真实缺口；要采集/结构化再引入 |
| `rate-limiter-flexible` 11.2.1 / `hono-rate-limiter` 0.5.4 | **暂缓**（接通登录时必上） | 现在只有 Bearer token 一条认证路径，爆破面是 `/api/v1/identity/verify`；见 §4 S12.4 |
| `@noble/hashes` 2.4.0（0 deps，已审计） | **仅登录接通时用** | 它能把 `password.ts` 的 PHC 层（246 行）换成成熟原语且**双运行时可用**；但那个子系统现在没人调用（§1.4） |
| `svg-captcha` 1.4.0（1 dep，2019 年后基本停更） | 🚨 **不能用** | 本仓自己的约束排除它：`captcha.ts:4-15` 明确要求「**答案只以像素存在**」，而它返回的就是 SVG —— 答案以文本躺在响应体里，"fetch 一下就能读到"。同理 `captcha-canvas` / `sharp` / `canvas` 会引入 native 依赖，**破坏双运行时**。这是「不是所有东西都该换库」的正例 |
| `write-file-atomic` 类 | **不换** | `member-admin.ts:408` 的 `tmp + rename + 0o600` 只有十几行，且与「先落盘再 replaceAll」的顺序强耦合（红线 8）；换库只换来一个中间层 |
| `drizzle-orm` 0.45.3（0 deps，支持 `bun:sqlite`/`node:sqlite`） | **不换** | ① `core/db` 的双驱动 parity 与 `finalize()` 语义是刻意设计，ORM 会把它藏起来；② 铁律「SQL 里不许出现公式」的诱惑会随 ORM 上升；③ 本仓「库坏了就重建、不写迁移」，与 migration 工具方向相反 |
| `@hono/zod-openapi` 1.6.3（3 deps） | **可选（S12.5）** | 收益是 OpenAPI 文档 + `hc<AppType>()` 类型化客户端（给 `web-portal` 与插件 `settings.ts`）；代价是路由写法要从「纯 REST 风格」变成「OpenAPIHono + createRoute」 |

---

## 4. 分阶段落地（S12.0 → S12.5）

> 每阶段都是**独立可交付、可回滚**的一段。S12.0 是安全网，必须先做。

### S12.0 安全网：把分发面钉进 `bun test`（0 新依赖）✅ 已落地

**动机**：`bun test` 重构前**不覆盖分发面**（§1.6）。
不先补网就改路由，等于在唯一没有断言的地方动刀。

**实际做法**
- 新增 `packages/server/test/http-contract.test.ts`（**41 项**），走
  `createHandlerFor()`（新抽出的「不起监听」接缝）—— **不起真服务**：
  本仓约定里「真 HTTP」属于 `bun run` 的 e2e 脚本，`bun test` 里抢固定端口
  会被并发跑成随机失败（`docs/本仓工程约定.md` §3.2 写得很清楚）。
- 断言面：405 + `Allow` 逐字、413、静态命中/未命中/`%zz`→400/编码穿越、
  SPA 回落、`/api/health` 四字段、三条 `/api/local/*` 的门控、
  admin 的 401/403/405/404/200+ok:false、上报的 401/405/400/413/200。
- **红绿证据**：这套断言先在**未改动的代码**上跑 → `39 pass / 2 fail`，
  失败的恰好是「`/api/*` 未命中返回 200 HTML」这两条**刻意变更**。
  也就是说：安全网抓得住行为漂移，且变更范围是可枚举的。

**顺带修掉的 3 个小瑕疵**（§1.7）：
1. `credentials.ts` 里那条「路径：`ATR_CREDENTIALS` 环境变量」的假文档
   （代码从未读过该变量）；
2. `identity-route.ts` 把超时文案写死成 `请求超时（8s）`，
   而超时值是可配置的 `verifyTimeoutMs` → 改成读真实值；
3. 文档基线漂移（`docs/本仓工程约定.md` §7 仍写 168 个测试）。

### S12.1 Hono 接管路由（行为零变化）✅ 已落地

**实际改动**
- 新增依赖：**只有 `hono@4.13.9`**（精确锁版本）。`@hono/node-server` 装过又被移除，
  理由见 §3.5。
- 新增 `src/app.ts`：中间件 + 路由表 + 兜底；路由条数与 §1.2 的九条一一对应。
- `index.ts` 从 680 行瘦到约 270 行，只剩「组装 + 起监听 + 启动元信息」。
- `tryListen` / `serveWithPortRetry` / `isPortInUse` 抽到 `runtime/listen.ts`（逻辑一字未改）。
- **domain 一行语义都没改**（只把「自己算 401/503」换成调用 `authorize()`）。

**实测发现（三条，都是不看源码看不出来的）**

1. 🚨 **Hono 不做 405**：方法不匹配时它只是「没匹配上」，最终回 **404 纯文本
   `404 Not Found`**，且没有 `Allow` 头。必须显式用 `hono/method-not-allowed`
   （它读 `app.routes` 反查允许的方法集）。
2. 🚨 **兜底必须 `app.use('*')`，绝不能 `app.get('*')`**：
   `get('*')` 会作为一条 **GET 路由**登记进 `app.routes`，于是
   `method-not-allowed` 认为**任何路径都允许 GET** —— 后果是
   `GET /api/v1/token-usage` 永远拿不到 405，而未注册的路径 POST 上去
   反而得到 `405 + Allow: GET`（比 404 更误导）。这一条已写进 `app.ts` 的注释。
3. ⚠️ `method-not-allowed` 会把 **HEAD 并进 GET 的允许集合**，
   而本仓的对外契约是「`Allow` 恰好列出真实处理器」（`e2e-ingest.ts:222` 逐字断言），
   所以 `onMethodNotAllowed` 里要滤掉 HEAD。

**验收（实测）**：契约测试 41 项 + 三个 e2e（27/35/54）+ `verify:npm:cli`
（Node 与 Bun 两个运行时的 `web` 子命令都过）+ `bun test` 全仓 557 项，全部 exit 0。

### S12.2 中间件收编（真正的收益段）✅ 已落地

**实际改动**
- `http/auth.ts` 的 **`authorize()`**：401/503 映射与管理员 403 门的**唯一实现**
  （原先三处各写一遍），保留「先认人、再认角色」的顺序与 `registered` 三态。
- `verify-route.ts`：`resolveIdentity` 改为导出（供 `authorize()` 复用）；
  新增 `viewerFrom()` —— **「角色缺省 member」从此只有一处**（原先
  `verifyToken` 与 `resolveIdentity` 各写一遍，任一处写成 `?? 'admin'`
  就是「人人可发 token」）；两句失败文案提为 `INGEST_AUTH_MESSAGES` /
  `VIEWER_AUTH_MESSAGES` 常量（措辞差异是刻意的，见文件头）。
- `http/envelope.ts`：`json` / `fail` / `methodNotAllowed` / `respond` 的唯一落点
  （原先 `{ ok:false, reason }` 手写约 31 处）；`app.onError` 接管 500 兜底。
- `http/body.ts`：`requestBodyLimit()`（库）+ `readJsonBodyStrict` /
  `readJsonBodyLenient`（**两种策略共用一个 `JSON.parse`**）——
  原先 4 条读取路径、语义各自为政。
- `hono/logger` + `hono/request-id` + `hono/secure-headers` 接上；
  CORS **刻意不接**（同源部署）。
- 🚨 `/api/*` 未命中一律 **JSON 404**：原计划放在 S12.3，但 S12.1 的
  `use('*')` 兜底顺手把它做掉了 —— 而且不做不行（否则 GET 兜底会把
  `/api/*` 接成 200 HTML）。这正是 §1.5 记录的那个前端已踩过的坑。

### S12.3 静态托管升级 ✅ 已落地

**实际做法**（`http/static.ts` + `app.ts` 的两行接线，全部实测）：

| 项 | 落点 | 关键取舍 |
|---|---|---|
| `ETag` + `304` | `static.ts` 派生 **弱 ETag**（`W/"<size16>-<mtime16>"`，stat 派生、不读内容），`hono/etag` 负责比对与 304 | ★ 刻意用**弱** ETag：同一 URL 在 gzip 与明文下字节不同，强 ETag 按定义不能跨编码复用；且 `hono/compress` 本来也会降级，从这里写弱可避免「200 发强、304 发弱」 |
| `Cache-Control` | `cacheControlOf(rel)`：`assets/` 下**且文件名带 hash** 的 Vite 产物 → `immutable`；其余（含 `index.html` 与 SPA 回落）→ `no-cache` | ⚠️ 双条件是为了不误判 `favicon.svg` / 手工放进 assets 的 `logo.svg`；用 `no-cache` 而不是 `no-store`（否则 ETag 白算），**也不能**是 `no-transform`（`hono/compress` 一见它就整段跳过） |
| `HEAD` | 与 GET **共用同一处响应构造**（头逐字相同、body 为 `null`） | 需要显式 `Content-Length`（HEAD 要报长度，且它是压缩阈值的依据） |
| gzip | `hono/compress`，**只对非 `/api/*` 生效**（`staticOnly()`） | ⚠️ 304 由内层 etag 先组出，compress 看到没有 body/Content-Type 的 304 即跳过 → **304 不会被压缩或改写**，且不做无用压缩 |
| 容器校验 | `resolve()` + `startsWith` **之后**再 `realpath()` 比对 | ⚠️ `resolve()` 只看字符串、不看 inode：dist 里一个指向外面的软链就能绕过第一道。两边一起 realpath，所以「dist 本身是软链」的正常部署不受影响 |

**刻意没做 / 取舍**（都是与「不引入回归」有关，不是遗漏）：
- **`Range` 仍不支持**：不在本项范围内，且 `immutable` 下浏览器基本不发。
- **MIME 表仍手写**：`hono/utils/mime` 的 `getMimeType('.html')` **不带 `charset=utf-8`**，
  换过去等于引入「HTML/JS 编码靠浏览器猜」的回归。
- **304 不带 `Vary: Accept-Encoding`**：按 RFC 9111 §4.3.4 缓存里的 Vary 仍在，不影响正确性；
  换来的是 304 路径不做无用压缩。
- **HEAD 不带 `Content-Encoding`**：`hono/compress` 对 HEAD 直接跳过（RFC 9110 §9.3.2 允许）；
  不带 `Accept-Encoding` 时 HEAD 与 GET 的头逐字一致。
- **符号链接校验的代价**：每次静态命中多两次 `realpath()`（微秒级；静态请求量很小且有缓存）。

**验收**：`packages/server/test/http-contract.test.ts` 里新增了 S12.3 的 `describe` 块
（覆盖 304/弱 ETag/两档 `Cache-Control`/HEAD/压缩/`/api/*` 不被波及/5 种编码穿越 + 符号链接穿越），
全仓 `bun test` 全绿；另有仓外真套接字脚本做过 `Bun.serve` 与 `serve-node.ts` 两侧复核。
✅ 原计划里的「`/api/*` 未知路径改 JSON 404」**已在 S12.1 做掉**（且必须做，见 §4 S12.1 的实测发现 2）。

### S12.4 孤儿子系统裁定（**先决策，再写代码**）✅ 已按 A 执行

**事实**：843 行 src + 616 行测试，零生产调用方，`passwordHash` 连凭证解析器都不读（§1.4）。

| 选项 | 代价 | 结论 |
|---|---|---|
| **A. 删除** | 需要时重建；git 历史保留 | ★ **已执行**。零调用方 + 零接线 = 纯粹的维护成本与「看起来能用」的错觉 |
| B. 接通登录 | 要新做：登录路由 / 会话 / 限流 / 前端页；`passwordHash` 要进 `credentials.ts` 解析器 | 只有「部门页要有密码登录」是**已确认需求**时才做 |
| C. 冻结 | 加「未接通」标注 + 从覆盖率里排除 | 最差：既留成本又不产生能力 |

**删除清单**：`src/{password,captcha,png,dot-font}.ts`、
`test/{password,captcha,png,dot-font}.test.ts`、`scripts/hash-password.ts`、
`package.json` 的 `hash-password` script、`tsconfig.json` 的 `scripts/**/*.ts`。
`bun test` 从 28 文件/557 项变成 **25 文件/557 项**（删掉 41 项、新增契约测试 41 项）。

若将来选 B，选型落地（**重建时照这个来**）：
- 哈希：`@noble/hashes` 2.4.0 替换自研 PHC 层（保留 BOM/CR 归一 —— 那是本仓自己踩出来的坑，红线 12）；
- 会话：`hono/cookie` + 服务端会话表（**不要**把角色放进 cookie）；
- 限流：`hono-rate-limiter` 或 `rate-limiter-flexible`；
- 验证码：**必须自研位图**（`node:zlib` 手写 PNG + 点阵字模）——
  返回 SVG 或文本答案的库一律排除（§3.6），带 native 的 canvas 会破坏双运行时。

### S12.5 校验 schema 化（zod）✅ 已落地

**落地范围**（刻意比原计划**收窄**，理由见下）：

| 项 | 落点 | 说明 |
|---|---|---|
| schema 单一真源 | `packages/shared/src/schemas.ts` | 只放**请求体形状**（上报载荷整批 + 单行、人员管理四个动作的 body） |
| 子路径导出 | `shared/package.json` → `exports["./schemas"]` | 🚨 **`shared/src/index.ts` 绝不 re-export** —— 否则 zod 会进 `web-local` / `web-portal` / 插件浏览器半的产物 |
| 消费方 | `server/src/ingest-route.ts` / `admin-route.ts` | 校验位置不变（仍在路由里、JSON 解析之后） |
| 依赖 | `zod` **精确锁** `4.6.5`（`bunfig.toml` 的 `exact = true`） | 加在 `shared` |
| 跨包类型 | `server/tsconfig.json` 的 `paths` 补 `@ai-token-report/shared/schemas` | 本仓约定：**新增跨包 import 就要在该包加一条 paths**，否则 `tsc` 找不到而 `bun` 跑得通 |

**刻意不做的两件**：
1. 🚨 **不动查询参数解析**（`stats-route.ts` 的 `period/bucket/by/from/to`、`local-api.ts`）：
   那几处的文案与「非法值**不许**静默当成没给」的语义很细（`stats-route.ts:434-436`），
   schema 化的收益低而回归风险高。
2. 不引入 `@hono/zod-validator` 去**替换**整条解析流程：那会把
   「`/api/v1/identity/verify` 非法 JSON 静默忽略」等既有语义、以及
   `{ ok:false, reason }` 的形状交给库 —— 而这两样都被逐字断言钉着。

**验收**（关键两条）：

```bash
bun test                                        # 677 pass（含新增的 schemas.test.ts）
bun run --filter '@ai-token-report/shared' verify:bundles   # ★ zod 不在 web-local 产物里
bun run packages/server/test/e2e-{ingest,admin}.ts          # 35 / 54 项（逐字文案与状态码没变）
bun run packages/server/verify/verify-mysql-portal.ts       # 53 项（双后端仍逐位一致）
```

> 💡 「zod 不进前端产物」这条**必须有可执行断言**：`exports` 的写法是**约定**，
> 而约定会被下一次「顺手在 index.ts 里 re-export 一下」破坏，且破坏后
> 前端只是变大、不会报错。`verify:bundles` 就是为这个而存在的。

---

## 5. 迁移红线（库不管这些，必须留住）

> 每条都有对应的现有注释或测试，改这些地方的 PR 必须逐条自检。

1. 🚨 **三族状态码语义**：上报与看板鉴权失败 = `401/503`；
   admin = `401/403/503`；`verify` 与本地署名 = **`200 + ok:false`**。
   三族**刻意相反**（`index.ts:26-28`、`437-438`、`448-449`、`admin-route.ts:16-30`、
   `stats-route.ts:20-25`）。
2. 🚨 **admin 的业务失败仍是 `200 + ok:false`** —— 「输入需要改」不是「身份需要换」。
3. 🚨 **`403` 的响应体里不得出现名单与 token**（`e2e-admin.ts:176-178`）。
4. 🚨 **Bearer 解析不要换成通用正则**：`Bearer` / `Bearer   `（只有前缀）
   必须落进「无 token」分支，否则会把 `"Bearer"` 当 token 去校验
   （`verify-route.ts:38-41`，实测踩过）。
5. 🚨 **`name` / `role` 只来自凭证表**，调用方不得用客户端提交的姓名覆盖；
   角色缺省 = `member`，**永不默认成管理员**（`credentials.ts:103-106`）。
6. 🚨 **任何会 import `node:http` 的模块都不能在 Bun 上被求值**：
   `node:http` 在被求值的那一刻就构造 `http.globalAgent` 并解析 `HTTP_PROXY` ——
   环境里一个非法值（**本机实测：末尾带 CRLF 的 `HTTP_PROXY`**）会让
   **跑在 Bun 上的服务端也崩在 import 阶段且没有一行启动日志**。
   `serve-node.ts` 因此把 `await import('node:http')` 放在**函数体内**；
   本次实测发现 `@hono/node-server` 连**动态** import 都不行（它自己顶层就 import），
   这就是没采用它的原因（§3.5）。
7. 🚨 **`idleTimeout` 仍是 120 秒**（`runtime/listen.ts` 的 `IDLE_TIMEOUT_SECONDS`），
   若将来引入 `hono/timeout`，其值不得小于它 ——
   否则冷建库（约 15 秒）会被掐断且服务端无日志。
8. 🚨 **先落盘、再整体替换内存镜像**；**读不懂的凭证文件拒绝一切写入**
   （`member-admin.ts:11-28`，`e2e-admin.ts:347-355` 钉着）。
   —— 这一条意味着**不要把凭证持久化换成通用 JSON store**。
9. 🚨 **最后一个管理员不可删 / 不可降级**；**姓名唯一**；**env 管理员永不写回文件**。
10. 🚨 **全进程只有一个 `CredentialStore` 实例**（`e2e-admin.ts:216/220`）。
    Hono 的中间件模型很容易让人「每个路由 new 一个 store」——**不要**。
11. 🚨 **归属只信服务端**：`client.userName` 一律忽略（`verify-route.ts:102-103`）。
12. 🚨 **口令哈希若将来重建（S12.4 选项 B）**：BOM/CR 归一必须保留、且生成端与
    校验端共用同一函数；**不做 trim**（`' pass'` 与 `'pass'` 是两个密码）。
    —— 该子系统现已删除，这条留给重建时用。
13. 🚨 **`/api/local/*` 只在 `enableLocalApi` 时挂载**；`portal.sqlite` 与
    `usage.sqlite` 两个入口永不混用。
14. 🚨 **`core/db` 的 SQL 里不许出现口径公式**，`driver.ts` 之外不许
    `import 'bun:sqlite'`（本条不因本次重构松动）。

---

## 6. 风险、代价与**已知问题**

| 风险 | 实情 | 处置 / 结果 |
|---|---|---|
| 新依赖进 npm 产物 | `cli` 依赖 `server`，`build:npm` 会把 server 打进 `dsh-token-report` tarball | ✅ **实测仍为零运行时依赖**：`hono` 被内联进 `cli.js`（233.3 KB），`verify:npm:cli` 断言「零运行时依赖」通过 |
| 版本漂移 | `bunfig.toml` 是 `exact = true` | ✅ 锁成 `hono: "4.13.9"` |
| 「第二套路由」复发 | 有人为 Node 单独写分支 | 路由与中间件**只在 `app.ts` 一份**；两个运行时的差异只允许出现在 `runtime/listen.ts` 与 `serve-node.ts` |
| 状态码悄悄变 | Hono 默认**不做 405**、404 是纯文本 | ✅ 契约测试 41 项钉住；`Allow` 逐字断言 |
| 「护栏被框架吃掉」 | 中间件顺序会改变鉴权与解析的先后 | ✅ 三个 e2e（27/35/54）+ 171 项路由单测全绿 |
| 工作量 | S12.0 → S12.1 → S12.2 一次做完 | 已回本：`index.ts` 680 → ~270 行，HTTP 机械动作全部收敛到 `http/` 与 `app.ts` |

### 🚨 已知问题（**与本次重构无关**，但会挡住「全绿」验收）

1. **本机环境变量 `HTTP_PROXY` / `http_proxy` 末尾带 LF**（实测 `len=23`，
   最后一个字符是 `\n`）。后果：**任何由 Node 执行的进程在求值 `node:http` 时直接崩**
   （`ERR_PROXY_INVALID_CONFIG`）。具体表现：
   - `bun run typecheck` **在改动之前就是红的** —— `tsc` 由 Node 跑，起不来；
   - `@hono/node-server` 在 Bun 上也崩（§3.5 的实测）。
   临时绕过：`[System.Environment]::SetEnvironmentVariable('HTTP_PROXY', $null)`
   （本次所有验收都是这么跑的）；根治要改 Windows 里那个变量本身。
2. **`web-portal` typecheck 失败**：`packages/web-portal/vite.config.ts` import 了
   `unplugin-vue-components/{vite,resolvers}`，但 `packages/web-portal/package.json`
   **没有这个依赖**（工作区里未提交的改动）。因此 `bun run typecheck` 是 6/7 包 exit 0，
   而 `AGENTS.md` / `docs/本仓工程约定.md` 写的「7 包全过」在当前工作区不成立。
   ⚠️ **不要**为此顺手加依赖 —— 那是前端在做的别的工作，需要那边自己补。
3. **仓内 `.bun-cache/` 目录在 Windows 上会 EPERM**（`bun add` 报
   `moving "hono" to cache dir failed`）。绕过：给 bun 指定仓外缓存
   （`$env:BUN_INSTALL_CACHE_DIR = 'D:\bun-cache-ext'`）；根治要查该目录的权限/占用。

---

## 7. 与现有文档的关系

| 文档 | 关系 |
|---|---|
| `ARCHITECTURE.md` | 平台级梳理与 §8 实施顺序（S0~S11）。本方案是 **S12 系列**，落地后应回填 §7 待决项与 §8 表格 |
| `AGENTS.md` | 「要改什么先读」表里加指向本文的一行；§非显而易见的约束中与 server 相关的条目**不因本次重构失效** |
| `docs/本仓工程约定.md` §5 | 「新增依赖前先过三问」。本方案对 Hono 的三问答复：① Bun/Node 原生**不能**替代（原生只能起服务，不提供路由/中间件）② `shared` 不用它（只有 `zod` 进 `shared/schemas` 子路径）③ 不进插件热路径（server 与插件 `emit()` 无关） |
| `.agents/skills/repo-conventions` | 同上，改动时两处同步 |

---

## 附：如果只做一件事

**已完成**：S12.0 + S12.1 + S12.2 + S12.3 + S12.4 —— 分发面契约测试补上了，
185 行 `if` 链换成了 Hono 路由表 + 中间件，静态托管补上了 ETag/304/两档 `Cache-Control`/HEAD/gzip
与 `realpath` 容器校验，843 行孤儿代码删掉了；
`bun test`（643 项）/ 三个 e2e / `verify:npm:cli` / 双后端对账（53 项）全绿。

**下一步（谁接着做都一样）**：
1. **S12.5**（`zod` schema 化）—— 进行中：`schema` 放 `shared/src/schemas.ts` 子路径导出，
   根入口**不** re-export（否则 zod 进前端产物），并有脚本断言它没进 `web-local` 产物。
2. 消掉 §6 的三个已知问题（尤其第 1 条：本机 `HTTP_PROXY` 带 LF，
   它会让**任何**由 Node 执行的工具链起不来）。
3. 可选：把 `Range` 请求与 MIME 表交给库（S12.3 刻意没做的两项，理由见那里）。