# `@ai-token-report/dsh-plugin` —— DSH token 上报插件

装在 DSH 里，**无人值守地**把本机产生的计费级 token 用量实时上报到部门服务端，
同时给同事一个「问一句就能看到自己用量」的工具。

```
① 实时上报   SessionTelemetryBackend.emit(record)    ← 会话进行中，秒级
② 统计工具   token_usage / token_usage_diagnostics   ← Agent 可调用
③ 统计服务   ctx.tokenReport                        ← 其它插件可调用
```

三种形态与 CLI `dsh-token`、本地页面走**同一套聚合与同一套口径**，
所以「工具报的数」与「页面上的数」必然一致。

---

## 1. 一份全局配置

团队铺开时，每个人机器上的差异应当只有「身份」一项。其余全部来自同一份下发配置：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: token-report
  # ⚠️ 必须是**已发布的包名** —— loader 用它来 import
  name: '@ai-token-report/dsh-plugin'
  config:
    # ── 全局配置 ────────────────────────────────────────────────
    name: dsh-token-report                      # 插件实例名，同时上报为 client.name
    appKey: !!js `process.env.ATR_APP_KEY`      # ★ 上报凭证，走 Authorization: Bearer
    endpoint: https://portal.example.com/api/v1/token-usage   # 计费上报地址

    batch:
      maxRecords: 50                # 单批最大条数
      flushIntervalMillis: 10000    # 定时冲刷间隔（turn 结束会额外触发一次）
      timeoutMillis: 15000          # 单次请求超时

    outbox:
      enabled: true                 # 磁盘 outbox（崩溃不丢）。默认开
      dir: ~/.dsh/token-report/outbox
      maxBytes: 33554432            # 超限丢**最旧**的批并告警

    features:
      reporting: true               # 关掉即完全不上报
      tools: true                   # 注册 token_usage 工具
      service: true                 # 注册 ctx.tokenReport

    localDb: false                  # ⚠️ 见 §5「本地库」

    # ── 身份（选填）─────────────────────────────────────────────
    # 留空则读 $DSH_HOME/token-report/identity.json（员工自己在本地页填的那份）
    # user:
    #   name: 张三
    #   token: atr-zhangsan-9f3c
    #   dept: 研发一部
```

### 取值的优先级

```
代码默认值  <  环境变量  <  插件 config
```

环境变量这一级是给 CI / 容器 / 临时排障用的：

| 环境变量 | 对应配置 |
|---|---|
| `DSH_TOKEN_REPORT_NAME` | `name` |
| `DSH_TOKEN_REPORT_APP_KEY` | `appKey` |
| `DSH_TOKEN_REPORT_ENDPOINT` | `endpoint` |
| `DSH_TOKEN_REPORT_BATCH_MAX` | `batch.maxRecords` |
| `DSH_TOKEN_REPORT_FLUSH_INTERVAL_MS` | `batch.flushIntervalMillis` |
| `DSH_TOKEN_REPORT_TIMEOUT_MS` | `batch.timeoutMillis` |
| `DSH_TOKEN_REPORT_OUTBOX` | `outbox.enabled`（`1/true/yes` 或 `0/false/no`） |
| `DSH_TOKEN_REPORT_OUTBOX_DIR` | `outbox.dir` |
| `DSH_TOKEN_REPORT_OUTBOX_MAX_BYTES` | `outbox.maxBytes` |
| `DSH_TOKEN_REPORT_LOCAL_DB` | `localDb` |
| `DSH_TOKEN_REPORT_USER_NAME` | `user.name` |
| `DSH_TOKEN_REPORT_USER_TOKEN` | `user.token` |
| `DSH_TOKEN_REPORT_DEPT` | `user.dept` |

> 前缀刻意用 `DSH_TOKEN_REPORT_` 而不是 CLI 的 `DSH_REPORT_*` ——
> 两者是不同的部署面，混用会让「我改了变量为什么没生效」变成谜题。

**写错的数字不会让 DSH 起不来**：非正数一律回退默认值并告警。
半份身份（只填了名字没填 token）视为「这一级没配」，回退下一级 ——
半份身份比没有更危险，它会让判定误以为已署名却带着空凭证发请求。

### 默认值

| 项 | 默认 |
|---|---|
| `name` | `dsh-token-report` |
| `endpoint` | `http://127.0.0.1:8787/api/v1/token-usage` |
| `batch.maxRecords` | `50` |
| `batch.flushIntervalMillis` | `10000` |
| `batch.timeoutMillis` | `15000` |
| `outbox.enabled` | `true` |
| `outbox.maxBytes` | `33554432`（32 MB） |
| `features.*` | 全 `true` |
| `localDb` | `false` |

---

## 2. 安装

### 2.1 先决条件

- **`appKey`**：管理员发放的上报凭证。没有它插件**不会上报**（这是合规底线）。
- **`endpoint` 可达**：默认指向本仓部门服务端。
- `@deepseek-ai/dsh-session-telemetry` ≥ `0.1.5-rc.1`（DSH 自带）。

> ⚠️ **与官方 OTel 后端互斥**：同一时刻只能挂载**一个** telemetry 后端
> （cordis 重复注册同名服务会抛错）。装了本插件就不要同时启用
> `@deepseek-ai/dsh-session-telemetry-otel`。

### 2.2 构建

```bash
bun install
bun run --filter '@ai-token-report/dsh-plugin' build
# → packages/dsh-plugin/lib/index.js（约 66 KB）
#
# ⚠️ 构建**不能**加 --external '@ai-token-report/*'：
#   本仓 workspace 包的 main 指向 src/index.ts（Bun 能直接吃，Node 不能），
#   把它们 external 出去会让 DSH（跑在 Node 上）加载即失败。
#   打包产物里只保留 @deepseek-ai/* 为 external。
```

### 2.3 放进 DSH profile

两步都要做 —— 少任何一步都不会生效：

**① `dsh.profile.bundles` 里加包名**（这决定 DSH 认不认这个包）：

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": {
    "@ai-token-report/dsh-plugin": "file:D:/Coding/ai-token-report/packages/dsh-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@ai-token-report/dsh-plugin"   // ← 加这里
      ],
      "patchReload": "live"
    }
  }
}
```

**② 插件的 `cordis.patch.yml` 负责 `insert`** —— 本包自带
（`package.json` 的 `dsh.bundle.patch` 指向它），格式必须是：

```yaml
# packages/dsh-plugin/cordis.patch.yml
- insert:                                  # ← 顶层是数组，元素里才是 insert
    - id: token-report
      name: '@ai-token-report/dsh-plugin'  # ← 必须是包名本身，loader 拿它去 import
```

> ⚠️ **三个格式陷阱**（都会让 DSH 起不来，且报错信息不直观）：
>
> | 写错的样子 | 报错 |
> |---|---|
> | 顶层写 `insert:` 映射而不是数组 | `overlay ... must be a top-level YAML array of loader patch entries` |
> | bundle 的 `package.json` 没有 `dsh.bundle.patch` | `profile bundle ... declares no dsh.bundle in its package.json` |
> | `name` 写别名而不是包名 | 启动时「找不到模块」 |
>
> 照抄 `@deepseek-ai/dsh-base` 的 `cordis.patch.yml` 最稳。

**③ 模块解析要通**：插件运行时只需要 `@deepseek-ai/*`（DSH 自带）。
如果包不在 `profiles/node_modules` 的解析范围内，用 junction 接一下：

```powershell
# Windows：把插件目录接到 profile 的 node_modules 下
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\@ai-token-report\dsh-plugin" `
  -Target "D:\Coding\ai-token-report\packages\dsh-plugin"
```

**④ 🚨 必须关掉官方 OTel telemetry 后端**（与 token-report 互斥）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: session-telemetry-otel
  disabled: true
```

不关掉它会直接启动失败：

```
service "sessionTelemetry" has been registered at <OpenTelemetrySessionBackend>
```

cordis 同一时刻只允许注册**一个** `sessionTelemetry` 服务。
该后端默认 `mode: FEEDBACK_ONLY`（只在提交反馈时上传到
`harness-telemetry.deepseeksvc.com`），关掉不影响任何本地功能。

⚠️ 官方明示限制：**新增依赖包需要重启 DSH**（`patchReload: live` 只对 patch 内容生效）。
升级插件版本同理。

### 2.4 验证装上了

```bash
# ① profile 组装里能看到插件行（最快，不起服务）
dsh --profile web --dump-config | Select-String token-report -Context 0,12

# ② 真启动
dsh --profile web --no-open
```

启动成功会打印 `dsh web: http://127.0.0.1:<port>/?token=...`。
插件启用时还会在 `$DSH_HOME/token-report/` 下**创建 `outbox/` 目录** ——
这是「后端真的构造了」最直接的证据（未启用时不会建）。

没看到启用时，日志会说明**为什么没启用**以及**怎么配** ——
不会只留一句「没启用」让人卡住。

### 2.5 回滚

```powershell
$w = "$env:USERPROFILE\.dsh\profiles\web"
# ① 从 bundles 与 dependencies 里去掉插件（改 package.json）
# ② 从 cordis.patch.yml 里删掉 token-report 段，并把 session-telemetry-otel 的 disabled 改回 false
# ③ 删掉 junction
Remove-Item "$w\node_modules\@ai-token-report" -Recurse -Force
# ④ 删掉插件产生的数据（state.json / usage.sqlite 是本地页与 CLI 的，按需保留）
Remove-Item "$env:USERPROFILE\.dsh\token-report\outbox" -Recurse -Force
# ⑤ 重启 DSH
```

---

## 3. 未署名 / 未配凭证 = 不采集也不上报

★ **这是合规底线，代码里硬保证，不要放宽。**

| 情形 | 行为 |
|---|---|
| 没身份文件 + 没配 `user` | **不注册上报后端**，一个字节都不发，只提示一次 |
| 有身份但没配 `appKey` | 同上（提示指向 `appKey` 怎么配） |
| `features.reporting: false` | 同上（明确说明是配置关掉的） |
| 三项齐了 | 注册上报后端，开始实时上报 |

提示文案的三条原则（写在 `identity.ts` 里，别改坏）：

1. 说明**去哪里填**，而不是抱怨「你没填」
2. 明确承诺**不采集** —— 含糊其辞反而更容易被拒绝
3. 区分「token 填错了」与「管理员还没发凭证」

> 为什么不按 `unknown` 兜底上报？那是**未授权的数据采集**。
> 宁可数据缺失（看板上能看到缺口），也不要偷偷采集。

---

## 4. 对外能力

### 4.1 工具（Agent 可调用）

**`token_usage`** —— 统计本机用量。只读本机会话日志，**不产生任何上报**。

| 参数 | 说明 |
|---|---|
| `period` | `today` / `yesterday` / `week` / `lastweek` / `month` / `lastmonth` / `year` / `last7d` / `last14d` / `last30d` / `last90d`，也接受中文（`今天` / `本周` / `最近7天`） |
| `by` | 分组维度，逗号分隔：`provider` \| `model` \| `provider-model` \| `project` \| `session` \| `day` \| `hour`（默认 `provider-model`） |
| `top` | 每个维度显示前 N 行（默认 30） |
| `series` | `day` \| `hour`，给了就附带趋势 |
| `provider` / `model` | 子串过滤 |

输出里 **四项 token 分列**，且缓存命中率带口径说明：

```
DSH token 用量  |  最近 30 天（自然日）
数据来源  直扫会话日志
耗时      11196ms

=== 总计 ===
  调用数        16,437
  计费总量      2,392,609,771   (input + output + cacheRead + cacheWrite)
    未缓存输入  70,379,895
    输出        9,754,881
    缓存读      2,312,474,995
    缓存写      0
  缓存命中率    97.0%   = cacheRead/(cacheRead+input)
  缓存杠杆      32.9x
```

**`token_usage_diagnostics`** —— 回答「我的数据到底发出去了没有」。
这个插件最大的失败模式不是报错，而是**静默地不上报**（凭证过期、地址改了、
outbox 满），看板上少了几个人的数据而没人发现：

```
=== token 上报链路诊断 ===
  插件名      dsh-token-report
  上报地址    https://portal.example.com/api/v1/token-usage
  凭证        已配置（不回显）
  ...
=== 投递统计 ===
  已采集      1,234 条
  已投递      1,230 条（服务端判定重复 4，拒收 0）
  磁盘待投递  0 条 / 0 批
  请求        25 次（失败 0 次）
  最近成功    2026/9/24 10:31:20
```

> 凭证**永不回显** —— 只报「已配置 / 未配置」。

### 4.2 服务（其它插件可调用）

```ts
const svc = ctx.get('tokenReport')

await svc.query({ period: 'today', by: ['provider'] })  // → UsageResult（不可变快照）
await svc.format({ period: 'week' })                    // → 渲染好的文本
svc.config                                              // ★ 不含 appKey
svc.signed()                                            // → 身份是否就绪
```

返回值是**某一刻的快照**而不是活会话 —— 调用方不持有 SQLite 连接，
也就不可能忘记 `close()`。

---

## 5. 两条数据源，且如实标注

| `source` | 路径 | 特点 |
|---|---|---|
| `local-db` | 本机 SQLite 增量库（`@ai-token-report/core/db`） | 快（热态 ~50ms），**但依赖宿主是 Bun** |
| `scan` | 直接扫会话日志（`@ai-token-report/core`） | 慢（冷态 10~13s），但任何运行时都能跑 |
| `none` | 没找到任何会话日志 | —— |

`source` 与 `degradedReason` 都会**如实带在结果里**。不允许在降级时假装数据来自库 ——
「这次为什么慢了 30 倍」必须能从输出里直接看出来。

> ⚠️ **`localDb` 默认 `false`**：`core/db` 依赖 `bun:sqlite`，而 DSH 宿主跑在
> **Node** 上，加载它会直接抛错。代码里用的是**动态 `import()`**，
> 所以即使误开也只是「库查询降级为直扫」，不会把整个插件（连同上报）拖垮。
> 只有确认宿主是 Bun 时才应打开。

---

## 6. 可靠性设计

| 要求 | 做法 |
|---|---|
| 不拖慢主循环 | 🚨 `emit()` 只做「折叠 + 数组 push」，零 IO；发送全在异步链路 |
| 崩溃不丢 | 磁盘 outbox，`pending-*` / `inflight-*` 两态 + 启动重放 |
| 网络抖动 | 单次请求不重试，失败整批留在 outbox，下个周期再发 |
| 停机排空 | `shutdown()` 先把内存队列落盘，再尝试发一次 |
| 重复投递 | 服务端按 `event_id` 幂等；客户端只保证 at-least-once |
| 主动降级 | 后台不可达时**只留在本地**，绝不阻塞或抛错影响 agent |

### outbox 的两态与崩溃窗口

```
pending-<ts>-<pid>-<seq>.jsonl    ← 新攒的批，还没发
inflight-<ts>-<pid>-<seq>.jsonl   ← 已发出但还没收到响应
```

- **先落 pending，再发请求**：发送前崩溃 → 数据已在磁盘上。
- **发送前 rename 成 inflight**：明确标记「这批可能已经到服务端了」。
- **成功响应后删除 inflight**；**失败则 release 回 pending**。
- **启动时把 inflight 全改回 pending 并重放** —— 这是「崩溃不丢」的兑现点。

重放会不会重复上账？**不会。** `event_id = sessionId:seq` 由服务端
`ON CONFLICT DO NOTHING` 去重。**宁可重发，不可漏发。**

超限时丢**最旧**的批并计入 `droppedBatches` 告警 —— 静默丢弃是不可接受的。

---

## 7. 隐私边界（🚨 不要放宽）

只上报 **token 数值 + 模型名 + 工作目录 + 轮次**，绝不带上对话内容。

`includeContent` **没有配置项** —— 它在类型与实现上都不存在，
所以不存在「配置写错就把内容发出去」的可能。代码层面另有两道保险：

1. **`session-telemetry/record` 脱敏瀑布**：DSH 的这条瀑布**默认不带任何规则**
   （记录会原样带出文件内容与命令输出）。插件自己挂一条**白名单**规则，
   把 body 裁到只剩 `usage` / `message.source` / `turn` / `step`。
   用白名单而不是黑名单：DSH 新增字段时，没在白名单里的一律不外发。
2. **`fold.ts` 只取需要的字段**：折叠后的记录结构里根本没有内容字段。

`sharing = 'full'` 是**部署策略声明**（「本部署全量共享会话遥测」），
不是投递回执。团队统一安装、员工已知情的前提下才成立 ——
合规评审会问到这里，改之前先在内部文档里说清楚。

---

## 8. 开发与验证

```bash
bun test packages/dsh-plugin            # 109 个用例（fold / config / outbox / reporter / apply / identity）
bun run --filter '@ai-token-report/dsh-plugin' typecheck
bun run --filter '@ai-token-report/dsh-plugin' build
```

四层验证脚本，**从内到外逐层接近真实**：

| 脚本 | 层次 | 断言数 | 验证什么 |
|---|---|---|---|
| `bun test packages/dsh-plugin` | 单元 | 109 | 折叠口径 / 配置优先级 / outbox 崩溃不丢 / 热路径只入队 |
| `verify/verify-plugin.ts` | 端到端冒烟 | 55 | **真 HTTP 往返** + 真扫日志 + 崩溃恢复（假 ctx） |
| `verify/verify-cordis-load.ts` | 真实框架装载 | 10 | 打包产物挂进**真 cordis Context**，含 `inject` 形状 |
| `verify/verify-resolution.ts` | **宿主语义** | 9 | 用 **Node**（不是 Bun）解析并加载打包产物 |
| `verify/diagnose-boot.ts` | 排障工具 | — | profile 里哪个包 import 就炸，展开完整 cause 链 |

另有三个辅助脚本：

```bash
bun run packages/dsh-plugin/verify/probe-activation.ts      # apply() 到底有没有被调用
bun run packages/dsh-plugin/verify/e2e-receiver.ts 18787    # 起一个真实接收端，供真实 DSH 会话验证
bun run packages/dsh-plugin/verify/repro-boot-failure.ts    # 复现激活失败并展开 cause
```

### 为什么必须跑「真实装载」这两层

单测全部用**假 ctx**，能证明**插件的逻辑**对，但证明不了**插件能被 DSH 装上去**。
本次安装验证实测抓到三个只有真实装载才会暴露的问题：

**① cordis 的 `ctx.get(name)` 返回服务代理，而 JS 私有字段（`#x`）穿不过 Proxy。**
任何在方法体里访问 `this.#x` 的公开方法，经代理调用都会抛
`TypeError: Cannot access invalid private field`。

而 `emit()` 正是被代理调用的 —— coordinator 持有的是代理对象，
也就是说**每一次会话事件都会炸**。单测里 `this.emit(...)` 拿到的是真实例，所以全绿。

**② `inject` 写在类上会静默失效。**
类根本不会被实例化（`apply()` 是被直接调用的），loader 读的是**插件条目对象**的
`inject`。写在类上的结果是：插件照常 import、`apply()` 也照常跑，
但「先等依赖就绪」的保证没了。

**③ 宿主是 Node，不是 Bun。**
本仓 workspace 包的 `main` 指向 `src/index.ts`（Bun 直接吃，Node 不能），
把它们 external 出去会让 DSH 加载即失败；`bun:sqlite` 被 bundler 提到顶层同理。

由此定下的规矩：**热路径与诊断入口一律不依赖私有字段**。
`emit` / `flush` / `shutdown` 走闭包实现的 `sink`，
`reporterStats` 是构造时挂上的可调用自有属性。

### 真实 DSH 会话的端到端实测结果

2026-09-24 在本机用 headless profile 跑了一次真实会话（插件 + 真实接收端），
服务端收到并落库的完整载荷：

```json
{
  "authorization": "Bearer <appKey>",
  "schemaVersion": 1,
  "client": { "name": "dsh-token-report", "userId": "张三", "userName": "张三", "dept": "研发一部" },
  "records": [{
    "event_id": "session-63fe9359-...:17",
    "session_id": "session-63fe9359-...",
    "seq": 17,
    "ts": 1790245427069,
    "provider": "dashscope",
    "model": "deepseek-v4.1-flash",
    "input_tokens": 10882,
    "output_tokens": 1,
    "cache_read_tokens": 0,
    "cache_write_tokens": 0,
    "reasoning_tokens": 0,
    "total_tokens": 10883,
    "cwd": "D:\\Coding\\ai-token-report",
    "turn": 1,
    "step": 1
  }]
}
```

逐项核对：appKey 只走 `Authorization` 头（请求体里没有）；**四个 token 列分列未合并**；
`total_tokens` 等于四项之和；身份来自服务端认可的署名文件而非客户端自填。

同时实测了两条合规行为（用真实会话 + 真实接收端计数验证）：

| 场景 | 结果 |
|---|---|
| 有身份 + 有 `appKey` | ✅ 收到 1 条记录 |
| 有身份 + `appKey` 为空 | ✅ 跑完整会话，**接收端 0 新增**，outbox 目录未创建 |
| 有 `appKey` + 无身份文件 | ✅ 跑完整会话，**接收端 0 新增**，outbox 目录未创建 |

### 文件分工

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口：`apply()` 装配、`TokenReportBackend`、脱敏规则 |
| `src/config.ts` | 全局配置归一化（默认值 / 环境变量 / 校验） |
| `src/fold.ts` | ★ 原始事件 → 计费记录（纯函数，唯一会算错数的地方） |
| `src/outbox.ts` | 磁盘 outbox（两态 + 启动重放） |
| `src/reporter.ts` | 内存队列 → 批量 → HTTP（热路径只入队） |
| `src/stats.ts` | 统计查询与渲染（**不实现任何公式**） |
| `src/identity.ts` | 身份解析（复用 core 的存储，与本地页共用同一份文件） |

### 三个「只有真实装载才能发现」的坑（都真实踩过）

| 坑 | 症状 | 规矩 |
|---|---|---|
| **cordis 服务代理 vs JS 私有字段** | 每次会话事件都抛 `Cannot access invalid private field`，而单测全绿 | 热路径与诊断入口一律不依赖 `this.#x`；见 §8 开头 |
| **`inject` 写在类上** | 插件能 import、`apply()` 也跑，但依赖注入的等待语义静默失效 | `inject` 必须在 **`default` 导出**上（类根本不会被实例化） |
| **bundler 提前拉入 `bun:sqlite`** | DSH（Node）加载插件即 `ERR_UNKNOWN_BUILTIN_MODULE` | 动态 import 的说明符要**构建期不可静态分析**（用变量拼） |

这三条都由 §8 的验证脚本兜住，改插件后**必须**跑 `verify-cordis-load.ts`。

---

## 9. 排障

### 9.1 安装期

| 现象 | 原因 | 处理 |
|---|---|---|
| `cannot resolve profile bundle "@ai-token-report/dsh-plugin"` | `dsh.profile.bundles` 加了，但 profile 的 `node_modules` 里解析不到 | 见 §2.3 ③，用 junction 或 `file:` 依赖接上 |
| `profile bundle ... declares no dsh.bundle in its package.json` | 包的 `package.json` 缺 `dsh.bundle.patch` | 加 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` |
| `overlay ... must be a top-level YAML array of loader patch entries` | `cordis.patch.yml` 顶层写成了 `insert:` 映射 | 顶层必须是数组，`- insert:` 是数组元素 |
| `service "sessionTelemetry" has been registered at <OpenTelemetrySessionBackend>` | 与官方 OTel 后端冲突 | 见 §2.3 ④，disable 掉 OTel |
| `ERR_UNKNOWN_BUILTIN_MODULE: bun:sqlite` | 构建时把 `@ai-token-report/*` external 出去了，或 bundler 把 `bun:sqlite` 提到顶层 | 见 §2.2 的构建命令 |
| `ERR_UNSUPPORTED_ESM_URL_SCHEME` | `file:` 依赖写成了 Windows 路径 | 用 `file:D:/...` 正斜杠形式 |

### 9.2 运行期

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动日志说「尚未署名」 | 没有身份文件 | 跑 `dsh-token --web` 在页面里填，或配 `config.user` |
| 启动日志说「未配置上报凭证」 | 没配 `appKey` | 配 `appKey` 或 `DSH_TOKEN_REPORT_APP_KEY` |
| 看板上没有我的数据 | 凭证过期 / 地址改了 / outbox 满 | 跑 `token_usage_diagnostics` 看 `lastError` 与 `磁盘待投递` |
| `$DSH_HOME/token-report/outbox` 目录不存在 | 上报后端从未构造（未署名 / 没 appKey / `features.reporting: false`） | 看启动日志给的原因；这是**预期行为**不是故障 |
| 工具报的数比看板少 | 正常 —— 看板是服务端累计，工具只看本机日志 | 用 `period` 对齐时间窗 |
| 统计很慢（10s+） | 走了直扫路径 | 确认 `localDb` 与宿主运行时；`source` 字段会如实标注 |

### 9.3 宿主环境（本机实测踩到）

`dsh` 的启动 shim 硬编码用 **`node`** 跑 `lib/bin.js`。如果 `node` 不在 PATH 上
（例如 nvm 的符号链接 `C:\nvm4w\nodejs` 被清空），shim 会**回退到 bun 的 node 兼容层**，
于是 `node:module` 缺 `stripTypeScriptTypes`，报：

```
SyntaxError: Export named 'stripTypeScriptTypes' not found in module 'node:module'
```

**这与插件无关** —— 移除插件后同样会失败。排查方式：

```bash
bun run packages/dsh-plugin/verify/diagnose-boot.ts web   # 逐个包试 import，指出谁炸
```

修法是让 `node` 回到 PATH（`nvm use <version>` 重建符号链接），
或直接用绝对路径调真 Node：

```powershell
& "D:\Program Files\nvm\v24.20.0\node.exe" `
  "$env:USERPROFILE\.bun\install\global\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  --profile web --no-open
```

---

## 10. 相关文档

| 主题 | 位置 |
|---|---|
| 口径公式（唯一真源） | `packages/shared/src/metrics.ts` |
| 上报与查询契约 | `packages/shared/src/protocol.ts` |
| 服务端接收接口 | `ARCHITECTURE.md` §5.2 |
| 身份署名与归属 | `.agents/skills/identity-attribution/SKILL.md` |
| 会话日志解析 | `.agents/skills/dsh-session-log-parsing/SKILL.md` |
| 工程约定 | `.agents/skills/repo-conventions/SKILL.md` |
| 插件方案（历史） | `docs/PLAN.md` |

