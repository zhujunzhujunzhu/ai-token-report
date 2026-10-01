# 服务端 MySQL 性能摸底与优化方案

> 本文是**实测报告**，不是设计文档。所有数字都来自本机隔离库上的可复现测量，
> 脚本在 `packages/server/verify/perf/`，复现命令见附录 A。
>
> 测试目标：回答「入库（上报）与统计（看板）在 10 万 / 100 万 / 300 万条事件规模下的
> 性能如何，瓶颈在哪，每个优化能提升多少」。
>
> 测量环境：Windows + Bun 1.4.2 + Docker MySQL 8.4.9（容器 `local-database-review-mysql`，
> 宿主端口 3335）。**本机环境是慢环境**（HTTP 回环固定开销 ~10ms、`Bun.serve` 每请求 ~65ms），
> 因此绝对值偏悲观，但**相对提升倍数**是有效的。

---

## 0. 结论速览

| # | 结论 | 实测影响 |
|---|---|---|
| 1 | 🚨 **`innodb_buffer_pool_size` 只有 128MB（容器默认），而 1M 行的表是 1.5GB** —— 这是最大的性能杀手，与代码无关 | 同一批查询：`totals` **4410ms → 128ms（34×）**，`groups(provider)` **19283ms → 187ms（103×）** |
| 1b | 🚨 **而且「表装得下」还不够**：3M 行（表 3.7GB）在 1GB pool 下 `diagnostics` **14.2s**，2GB 下 **1.68s（8.5×）** | 一个请求里连续跑多个全窗口查询会互相挤页；**按「整表体积」配，不是按单条查询配** |
| 2 | 🚨 **每个请求都跑一遍「schema 结构闸门」**（20 张表逐表查 `information_schema`，~116 条语句 / 69ms SQL） | 它是 `stats/groups`、上报等**轻请求**的 **76%~88%** 延迟；已实现批量优化：**SQL 69ms → 5.3ms，闸门 77ms → 30ms** |
| 3 | 🚨 **看板取数一律全窗口扫描**（`day`/`hour` 在 JS 分桶、`records` 全窗口 `COUNT(*)` + 排序、人员维度全表 `GROUP BY`） | 3M 行 / 2GB pool 下每个统计操作 **330~590ms**；30 天窗口要扫 24.6 万行 |
| 4 | 加索引**几乎没用**（瓶颈是磁盘 I/O 与结果传输，不是访问路径） | 三个候选覆盖索引在 1M 行上「加与不加」差异在噪声内；唯一例外见 §4.5 |
| 5 | 汇总表是**量级**提升 | 3M 行：`totals` **373ms → 0.8ms（467×）**，`series` **405ms → 0.9ms（450×）**，且顺带消掉结果传输 |
| 6 | 入库本身**很快**（200 行批量 INSERT 14~22ms），慢的是闸门 + 逐批串行 | 3M 行 ACK **230ms**（已优化）；闸门再缓存一档可到 **54ms / 3360 条/秒** |
| 7 | ⚠️ `assertLegacyIdentityView()`（旧视图自检）在 3M 行上 **364ms/请求** | 页面默认走 `identity_view=member` 不走它；但**服务端默认值是 `legacy`**，所以手写请求会踩到 |
| 8 | ⚠️ 每个请求把闸门跑 **4 遍**（`openPortalStore()` 被调用多次） | 已用 `probe-request-dup.ts` 钉住；收敛成 1 次可再省 `stats/groups` 152→30ms 那一档 |

**一句话**：先把 buffer pool 配够（配置问题，零代码），再把每请求的 schema 闸门降下来
（已实现），最后用汇总表把「全窗口扫描」换成「查几千行小表」（下一阶段）。

> 📌 **v8 汇总表已实现并验证**（2026-10-01）。实测结论分两层，**两层都要看**：
> - **SQL 层 193×~1862×**（3M 行：30 天聚合 346ms → **1.3ms**；时段分布 931ms → **0.5ms**）；
> - **端到端 1.0×** —— 本机一个请求的固定开销（HTTP + `Bun.serve` + schema 闸门 +
>   Node 侧重建 24.6 万个点）就有 ~860ms，SQL 省下的 350ms 在里面看不出来。
>
> ⇒ **结论是「现在不要部署，等阈值」**：线上表只有 77MB（30 天聚合 35ms），
>   部署它当前没有任何可感知收益。判据与完整数据见
>   `docs/汇总表设计规格.md` §8。
>   ⚠️ 它的实现仍然值得：口径已被 14 项单测 + 16 项活体断言钉住，届时只需配置；
>   而且顺带修掉了一个**静默少算**的真实 bug（水位游标卡死，见规格 §2）。

---

## 1. 测试夹具：数据是怎么造的

| 维度 | 取值 | 依据 |
|---|---|---|
| 规模 | 10 万 / 100 万 / 300 万条 | 用户口径：现 10 万/月 → 120 万/年 → 目标 300 万 |
| 人员 | 50（10 万）/ 200（100 万）/ 300（300 万） | 部门规模 |
| 供应商 × 模型 | 4 家 × 3 个模型 | 决定 `provider-model` 的分组行数 |
| 时间跨度 | 365 天，30 天窗口内 8.2% | 年度上报库的真实形态 |
| 会话 | 每人每天 1~3 个会话 | 决定 `COUNT(DISTINCT session_id)` 的代价 |
| token 量级 | `cacheRead` 占 94%+ | `AGENTS.md` 铁律 2 的实测口径 |
| 写入路径 | **本仓自己的** `insertAttributedRecordsInTransaction()` | 手工拼 INSERT 会造出「测出来好看、真写写不进去」的表 |

实测表体积（`usage_event`，含全部索引）：

| 规模 | data | index | 合计 | 每行 |
|---|---|---|---|---|
| 10 万 | 56 MB | 42 MB | **98 MB** | 1.07 KB |
| 100 万 | 565 MB | 938 MB | **1.47 GB** | 1.50 KB |
| 300 万 | 1332 MB | 2385 MB | **3.72 GB** | 1.24 KB |

> 💡 索引比数据大 ~1.8 倍，原因见 §4.5。**这是「buffer pool 要多大」的直接输入**。

---

## 2. 入库性能（`POST /api/v1/token-usage`）

### 2.1 实测（串行 20 批 × 200 条 = 4000 条，逐批等 ACK）

| 规模 / 配置 | ACK p50 | 吞吐 | 说明 |
|---|---|---|---|
| 10 万 / 128MB pool | **388 ms** | **487~527 条/秒** | 闸门占绝大部分 |
| 100 万 / 128MB pool | 423 ms | 455~485 条/秒 | 闸门占比被慢查询掩盖 |
| 300 万 / 1GB pool + 闸门优化 | **208 ms** | **818 条/秒** | 已实现优化后 |
| 300 万 / 1GB pool + 闸门优化 + 闸门缓存 | **54 ms** | **3360 条/秒** | 优化上界 |

### 2.2 逐条 SQL 归因（不经过 HTTP，量语句本身）

| 语句 | 中位耗时 | 说明 |
|---|---|---|
| `SELECT @@SESSION.sql_mode`（STRICT 检查） | 0.4 ms | 每次上报一次，在事务连接内 |
| `ingest_run` upsert | 0.5 ms | 每次上报一次 |
| **200 行多值 INSERT（含 3 个外键）** | **16 ms（10 万行表）→ 28 ms（300 万行表）** | 真正的写库成本 |
| `SAVEPOINT` / `RELEASE` / `COMMIT` | 7.6 ms | 事务控制 |

⇒ **写库本身只有 ~25ms/200 条**。ACK 里的另外 380ms 全是闸门与固定开销。

### 2.3 一个 200 行批次在 10 万行规模下的时间去处

```
ACK 388ms = 闸门 116 条 SQL (69ms) + 鉴权 + 写事务 (25ms) + 进程/HTTP 固定开销
```

`IngestQueue` 是**单消费者串行**的（`ingest-queue.ts`），所以吞吐 ≈ `200 / ACK`。
真实负载（100 人 × 每天 10 次上报 = 1000 请求/天 = **0.012 req/s**）离这个上限极远，
**入库不是当前的瓶颈**；要做的是别让闸门把 ACK 拖到 400ms（客户端超时 15s，余量因此变薄）。

---

## 3. 统计性能（`/api/v1/stats/*`）

### 3.1 端到端 HTTP 延迟（热态；300 万用 2GB pool，其余按表头标注）

| 端点 | 10 万 / 128MB | 100 万 / 128MB | 100 万 / 1GB | **300 万 / 2GB** |
|---|---|---|---|---|
| `overview`（30 天） | 522 ms | **15 030 ms** | 1 083 ms | 1 419 ms |
| `overview`（全时间窗） | 549 ms | 12 084 ms | 1 617 ms | 3 614 ms |
| `series:day` | 427 ms | 5 066 ms | 721 ms | 875 ms |
| `series:hour`（7 天） | 457 ms | 560 ms | 578 ms | 379 ms |
| `series+stack` | 542 ms | 10 359 ms | 1 144 ms | 1 516 ms |
| `breakdown:user` | 461 ms | 9 773 ms | 935 ms | 1 285 ms |
| `breakdown:group` | 349 ms | 392 ms | 389 ms | 200 ms |
| `breakdown:provider` | 684 ms | **25 194 ms** | 925 ms | 1 228 ms |
| `breakdown:model` | 613 ms | **54 446 ms** | 870 ms | 1 243 ms |
| `breakdown:provider-model` | 470 ms | 10 232 ms | 858 ms | 1 275 ms |
| `breakdown:project` | 541 ms | 14 479 ms | 1 227 ms | 1 758 ms |
| `breakdown:day` | 471 ms | 10 064 ms | 879 ms | 1 310 ms |
| `records:100` | 420 ms | 5 256 ms | 586 ms | 622 ms |
| `records:1000` | 454 ms | 5 839 ms | 620 ms | 700 ms |
| `diagnostics` | 422 ms | 9 956 ms | 912 ms | 1 680 ms |
| `groups`（候选） | 349 ms | 439 ms | 358 ms | **184 ms** |
| `members`（候选） | 383 ms | 410 ms | 376 ms | 189 ms |
| `providers`（候选） | 363 ms | 369 ms | 386 ms | 202 ms |
| `pricing`（单价快照） | — | — | — | 181 ms |
| `breakdown:user`（legacy 视图） | 496 ms | 14 751 ms | 1 031 ms | 1 622 ms |
| `overview`（legacy 视图） | 479 ms | 18 604 ms | 1 174 ms | 1 812 ms |

> 300 万那列是**当前已优化代码 + 2GB pool** 的结果（`--tag pool2048`）。
> 表头里的 128MB 列是容器默认配置下的原始形态 —— 两列的差别同时包含
> 「pool 从 128MB → 1~2GB」与「闸门批量化」，不要拆开引用。
>
> ⚠️ **测量纪律**（踩过两次，记下来免得后人重复）：
> ① `SET GLOBAL innodb_buffer_pool_size` 改的是**目标值**，页迁移是后台任务。
>   不等它稳定就开测，前两个端点的 p95 会冲到 10~17 秒，而 p50 正常 ——
>   `bench.ts` 现在会等到实际值吻合、确认失败就抛错拒绝压测。
> ② 每个端点测之前必须先**热身**（各打一遍不计入统计），否则「第一次查询」的
>   代价会记在第一个用例的 p95 上，看起来像那个端点自己有问题。

#### 冷启动（每个用例前 `FLUSH TABLES`；100 万 / 1GB pool / 每端点 1 次）

```bash
bun run packages/server/verify/perf/bench.ts --scale 1e6 --pool 1024 --repeats 1 --cold
```

| 端点 | 冷 | 热（同规模） | 说明 |
|---|---|---|---|
| `overview`（30 天） | **5 983 ms** | 1 083 ms | 第一个用例，包含 `openPortalStats` 首次开连接 + 全窗口首读 |
| `overview`（全时间窗） | 2 496 ms | 1 617 ms | |
| `series:day` | 543 ms | 721 ms | **冷热相当** —— `FLUSH TABLES` 只清本表页，而它在 1GB 下已热 |
| `breakdown:project` | 842 ms | 1 227 ms | |
| `diagnostics` | 729 ms | 912 ms | |
| `groups` / `members` / `providers` | 176 / 229 / 210 ms | 358 / 376 / 386 ms | 目录类端点本来就不碰 `usage_event` |

⇒ 结论：**冷启动的真实代价集中在「第一次真正读 `usage_event`」那一个请求上**
（首个用例 6 秒 vs 热态 1 秒），此后各端点的冷热差异不大 ——
因为 `FLUSH TABLES` 只清本表页，而请求之间的间隔足够让它们重新热起来。
运维含义：进程重启后的第一个看板请求会明显慢，**预热脚本**（启动后主动打一轮
`overview` + `series`）能把这段体验吃掉。

### 3.2 逐条取数 SQL（3M 行 / 1GB pool，30 天窗口 = 25.7 万行）

| 操作 | p50 | 返回行数 | 备注 |
|---|---|---|---|
| `totals()` | 356 ms | 1 | 全窗口四项求和 |
| `sessions()` | 328 ms | 1 | `COUNT(DISTINCT session_id)` |
| `distinctUsers()` | 374 ms | 1 | 子查询 `GROUP BY` + 外层 `COUNT` |
| `series(day)` | 491 ms | 24.6 万 | **原始行回 JS 分桶** |
| `stackSeries(user,day)` | 596 ms | 24.6 万 | 同上 + 人员键 |
| `groups(user)` | 541 ms | 45 | +3 趟分批人名/分组查询 |
| `groups(provider)` | 508 ms | 4 | |
| `groups(project)` | 885 ms | — | 两条 SQL（按 cwd 聚合 + 去重对） |
| `records(100)` | 405 ms | 100 | 先全窗口 `COUNT(*)` 再排序取 100 |
| `assertLegacyIdentityView()` | **363 ms** | 45 | 每个 legacy 视图请求都要跑 |
| **schema 闸门** | **30 ms**（优化后）/ 77 ms（优化前） | — | 每个请求 |

### 3.3 「按天/按小时趋势」为什么要扫全窗口

`query.ts` 的 `dimensionExpression()` 对 `day` / `hour` **刻意返回 null**，注释写得很清楚：
SQLite 的 `strftime(..., 'localtime')` 按**操作系统时区**、JS 的 `toDayKey()` 按**进程 TZ**，
在 `bun test` 下两者相差 8 小时 —— 于是时间分桶一律在 JS 侧做。

代价：**每次趋势请求把 30 天（24.6 万行）全部搬到 Node 进程里**。
这既是 SQL 时间，也是结果传输与 JS 物化时间（实测 ~2µs/行）。

---

## 4. 瓶颈归因（按影响排序）

### 4.1 瓶颈一：`innodb_buffer_pool_size = 128MB`（配置，非代码）

**证据**：同一批 SQL，只改这一个变量：

| 用例（1M 行，30 天窗口） | 128MB | 1GB | 提升 |
|---|---|---|---|
| `totals` | 4 410 ms | 128 ms | **34×** |
| `series 原始行` | 4 397 ms | 139 ms | 32× |
| `stack 原始行` | 4 507 ms | 161 ms | 28× |
| `memberGroups` | 4 713 ms | 200 ms | 24× |
| `groups(provider)` | **19 283 ms** | 187 ms | **103×** |
| `COUNT(DISTINCT session)` | 4 631 ms | 165 ms | 28× |
| `records 首页` | 4 817 ms | 143 ms | 34× |
| `旧视图自检` | 4 312 ms | 149 ms | 29× |

**机理**：128MB 装不下 1.47GB 的表，于是「按 `ts` 范围扫 30 天」退化成
「几乎每次都从磁盘读整张表」——而本机 Docker 的数据目录是**绑定挂载在 Windows 磁盘上**的，
随机读代价极高。实测磁盘读页数：`totals` 单次 **160 938 页 = 2.5GB**。

#### ⚠️ 而且「够装下 30 天窗口」还不够 —— 要看**一个请求里连续跑几条**

`probe-endpoint-pool.ts` 专门量**端到端端点**（而不是单条 SQL）在多档 pool 上的表现，
3M 行（表 3717MB）实测：

| 端点 | 1024MB | 2048MB | 4096MB |
|---|---|---|---|
| `diagnostics` | **14 238 ms** | 1 682 ms | 1 675 ms |
| `overview`（全时间窗） | **17 560 ms** | 3 637 ms | 3 533 ms |
| `overview`（30 天） | 1 406 ms | 1 412 ms | 1 417 ms |
| `breakdown:provider`（30 天） | 1 193 ms | 1 242 ms | 1 210 ms |

⇒ 1GB 时前两个端点崩掉 8~10 倍，而**30 天窗口的端点完全不受影响**。
原因是 `diagnostics` / `overview(all)` 在一个请求里连续跑 10 趟全窗口聚合，
每趟都会把上一趟还要用的页挤出去 —— **单条 SQL 的基准测试看不到这个现象**
（`probe-ops.ts` 量的是单条，1GB 下 `distinctUsers` 只有 374ms）。

**怎么定这个值**（可直接抄）：

```
innodb_buffer_pool_size ≥ usage_event 的 data_length + index_length
```

而且**要按整表体积算，不是按「一次查询要读多少」算** —— 一次请求会连着读好几遍。

| 事件规模 | 表体积（实测） | 建议 pool | 说明 |
|---|---|---|---|
| ≤ 10 万 | 98 MB | 256 MB | 容器默认 128MB 也勉强够 |
| 100 万 | 1.47 GB | **2 GB** | 实测 1GB 已能把单条查询压到 128~200ms |
| 300 万 | **3.72 GB** | **4 GB** | 🚨 1GB 时 `diagnostics` 14.2s；2GB → 1.68s；4GB 无进一步收益 |
| 1000 万 | ~12 GB | 16 GB | 同时上汇总表（§5.3） |

**验证指标**：上线后盯 `Innodb_buffer_pool_reads / Innodb_buffer_pool_read_requests`
应 < 1%；再用 `probe-endpoint-pool.ts` 加一档看还有没有收益（**要量端点，不要只量单条 SQL**）。

### 4.2 瓶颈二：每请求的 schema 结构闸门（已实现优化）

**证据**：`probe-gate-trace.ts` 逐条计时，一次 `openPortalStore()` 在 3M 行库上：

```
合计 68.81ms；未归属 4.12ms
  20 张表 × (columns 1 条 + statistics 1 条 + engine 1 条 + 外键 1 条 + CHECK 1 条)
  + eventColumns 1 条 + 主键 1 条 + 排序规则 1 条 + tablesOf 1 条 + portal_meta 1 条
```

`performance_schema` 侧确认：**116 条语句/请求，其中 84% 是闸门**。

**为什么它每请求都跑**：`openPortalStore()` → `ensurePortalReady()` →
`readPortalState()` + `verifyCurrent()`，注释明确说「每次都重读真实结构，不缓存版本或约束，
因此运行中缺表、篡改 CHECK 和半迁移仍立即拒绝」。它被 **6 处**调用：上报 1 处、
看板 5 处（其中 4 处是「候选目录」接口，各自只跑 1 条真正的查询）。

**已实现的优化**（`packages/core/src/db/portal-migrations.ts`）：

把「19 张表 × 各查一遍」换成「查一次全库目录，在 JS 侧按表分组」。
这些 `information_schema` 查询**本身都支持不带 `TABLE_NAME` 的全库过滤**，
所以「怎么取」变了、「比什么」没变。

| 检查项 | 原来 | 现在 |
|---|---|---|
| 列定义 | 每表 1 条 `columns` | 1 条全库 `columns` |
| 唯一约束 | 每表 1 条 `statistics` | 1 条全库 `statistics` |
| 外键 + RESTRICT | 每表 1 条三表 JOIN | 1 条全库三表 JOIN |
| CHECK + 执行状态 | 每表 1 条两表 JOIN | **每表 1 条但带 `TABLE_NAME`**（见下） |
| 存储引擎 | 每表 1 条 `tables` | 复用「表存在」那一条 |
| `event_id` 主键 / 排序规则 | 2 条 | 复用上面两条，只做过滤 |

🚨 实测踩到的坑：CHECK 的 JOIN **必须带 `TABLE_NAME` 条件**。
本机实例的 `information_schema.check_constraints` 有 **170 行**，
不带表名条件时 MySQL 要把每行的 `CHECK_CLAUSE` 文本（含正则）都取出来比较，
**单这一条 48ms**（比其余 7 条加起来慢 10 倍）；带上之后 1ms 量级。

**实测收益**：

| 指标 | 优化前 | 优化后 | 提升 |
|---|---|---|---|
| 闸门 SQL 服务端耗时 | 68.8 ms | **5.3 ms** | 13× |
| 闸门墙上耗时（3M 行库） | 77.3 ms | **30.4 ms** | 2.5× |
| `stats/groups`（HTTP，3M/1GB） | 152 ms | — | — |
| `stats/groups`（含闸门缓存，3M/1GB） | 152 ms | **29.5 ms** | 5.2× |
| `ingest(200)`（含闸门缓存，3M/1GB） | 222 ms | **53.8 ms** | 4.1× |
| 100k 规模全套 HTTP | 基线 | — | **58%~88%** |

**不做的事（以及为什么）**：曾实现过一版「版本指纹 + TTL 缓存」，把闸门降到
「命中即跳过」——`/api/v1/stats/overview` 一趟会触发 **4 次** `openPortalStore()`
（统计会话 1 次、读供应商别名 1 次、各候选目录接口各 1 次），所以缓存能把 4×8 条
`information_schema` 语句降到 0。但 `portal-v5.test.ts` 的活体用例当场判它失败：

```
DROP FOREIGN KEY fk_usage_v4_member  →  expect(openPortalStore(t)).rejects.toThrow('实际外键')
（缓存版：在一个 TTL 窗口内被放行）
```

「运行中改结构立刻拒绝」正是这道闸门存在的理由，而缓存只能把它降成
「最多 TTL 之后才拒绝」——**省下的时间不值这个价，已回退**。
真正干净的降本方式是**让一个请求只开一次库**（把 4 次 `openPortalStore()` 收敛成 1 次），
那是路由层重构，不动安全语义，列为待办。

### 4.3 瓶颈三：全窗口扫描与「先全扫再取 100」

**证据**（3M 行 / 1GB pool，30 天 = 24.6 万行）：

- `series` / `stackSeries` 把 24.6 万行搬进 Node 再做分桶（491 / 596ms）；
- `records` 先 `COUNT(*)` 全窗口（17ms）再 `ORDER BY ts DESC, seq DESC, event_id DESC LIMIT 100`
  —— **排序键与索引前缀不一致**（索引是 `ts`，排序键是三列），所以即使只取 100 行也要
  先把 24.6 万行排序（387ms），且这条 `ORDER BY` 无法用现有索引消除 filesort；
- `groups(project)` 跑两条 SQL（`GROUP BY cwd` + `DISTINCT cwd, session_id`），885ms。

**这一条是「300 万调用会不会有问题」的主要答案**：
它不随写入量爆炸（30 天窗口的行数才决定成本），但**每刷新一次看板都要付一遍**。

### 4.4 瓶颈四（次要）：每次请求把闸门跑 4 遍

`openPortalStore()` 在**一个看板请求里会被调用多次**：统计会话 1 次、读供应商别名
1 次、每个候选目录接口各 1 次。`probe-request-dup.ts` 用「一次请求 = 一个
`performance_schema` 统计周期」的办法钉住了这一点 —— **每个 stats 请求里，
闸门的每个指纹都恰好出现 4 次**：

```
【overview】共 30 条语句 / 9 种指纹
   ⚠️ 4 × 0.37ms  SELECT `schema_version` FROM `portal_meta` WHERE `id` = ?
   ⚠️ 4 × 4.47ms  SELECT TABLE_NAME AS `table`, COLUMN_NAME AS name, ... information_schema.columns
   ⚠️ 4 × 7.04ms  SELECT k.table_name, k.constraint_name, ... 外键 JOIN
```

⇒ 闸门批量化之后仍有 **4×** 的重复；把「一个请求只开一次库」收敛掉是干净的
下一步（属于路由层重构，不动安全语义）。实测收益上界：`stats/groups` 152ms → 29.5ms。

### 4.5 瓶颈五（次要）：索引把表撑到 1.8 倍

`event_id` 是 `varchar(255)` 且是主键，InnoDB 的**每个二级索引叶子里都带完整主键**。
7 个二级索引 ⇒ 索引 2290MB vs 数据 1280MB。

**实测：加索引并不能解决 §4.1 / §4.3**。1M 行上依次加
`(ts,member_id)`、`(ts, 四项 token)`、`(ts, session_id)` 三个覆盖索引，
`totals` / `series` / `groups` / `records` 全部**没有改善**（4792~22548ms 波动在噪声内）。
唯一有效的是：

| 用例 | 无 `(ts,session_id)` | 有 | 提升 |
|---|---|---|---|
| `COUNT(DISTINCT session_id)` | 4 960 ms | **36.6 ms** | **135×** |

⇒ 结论：**不要为了「让聚合快一点」批量加索引**（每加一个还要多撑 ~0.3GB 并拖慢写入）。
只有 `(ts, session_id)` 这一类「有明确覆盖收益」的才值得加，且要先在目标规模上验证。

---

## 5. 优化方案与实测提升

> 每条都给出：收益、代价、实测证据、落地位置。

### 5.1 ★★★ 把 `innodb_buffer_pool_size` 配够（配置，零代码）

- **收益**：1M 行 **24×~103×**；3M 行端点级 **8~10×**（`diagnostics` 14.2s → 1.68s）。
  是其余所有优化的前提（不配够，优化取数 SQL 几乎看不出效果）。
- **代价**：内存。3M 行建议 4GB（按**整表体积**算，不是按单条查询的读取量算）。
- **落地**：MySQL 配置 / `docker run -e` / `SET GLOBAL`（动态生效）。
- **证据**：`probe-pool.ts`（单条 SQL 的 128MB vs 1024MB 对照）
  + `probe-endpoint-pool.ts`（端点在 1/2/4GB 上的对照，发现「1GB 装得下 30 天窗口、
  但装不下一个请求里连续跑 10 趟」这个只有端到端才看得见的坑）。

### 5.2 ★★★ schema 闸门批量化（**已实现**）

- **收益**：闸门 SQL **69ms → 5.3ms（13×）**，墙上 **77ms → 30ms**；
  轻请求（候选目录 / 上报）整体 **4×~5×**，10 万规模全套 **58%~88%**。
- **代价**：零语义变化（见 §4.2 的对照表）；`verifyCurrent` 的 MySQL 分支换成
  `verifyCurrentMysql()`，SQLite 分支一字未动。
- **验证**：`bun test` **1459 pass / 0 fail**（含 `ATR_V4_TEST_MYSQL_URL` 实跑的
  7 项真实 MySQL 迁移用例）；`bun run typecheck` 7 包全绿；
  `bun run packages/server/verify/verify-mysql-portal.ts` **64 项全过** ——
  它用同一批数据起 SQLite / MySQL 两个服务端，断言看板每个接口的响应体 **JSON 逐位全等**，
  所以「批量化之后口径没变」不是靠推理，是靠对账钉住的。

### 5.3 ★★★ 汇总表（rollup）—— 解决「全窗口扫描」

- **收益（3M 行实测）**：

  | 用例 | 原始表 | 汇总表 | 提升 |
  |---|---|---|---|
  | `totals`（总览四项求和） | 373.5 ms | **0.8 ms** | **467×** |
  | `groups(provider)` | 422.6 ms | **1.0 ms** | **423×** |
  | `memberGroups`（人员聚合） | 478.0 ms | **1.4 ms** | **341×** |
  | `series` 按天 | 404.7 ms | **0.9 ms** | **450×** |

  汇总表：**(天, 人员, 供应商, 模型)** 粒度，3M 原始行 → **7 998 行 / < 0.1MB**，
  全量重建 **17.9s**（可增量：只处理新到的天）。

- **代价与边界（必须说清，否则数字没有意义）**：
  1. 🚨 **`sessions` 不可加**：同一会话跨天时「逐天去重后再求和」会**高估**。
     要精确必须回原始表（或另存 `(会话, 天)` 明细）。
  2. 🚨 **小时级趋势无法由它服务**（它按天存）；`bucket=hour` 仍需原始表。
  3. ⚠️ 时间桶口径必须与 `aggregate.ts` 的 `toDayKey()` 对齐（本机时区），
     不能改用 SQL 的 `strftime`/`FLOOR(ts/86400000)` 直接当真值 ——
     那正是 `query.ts` 花大力气避开的那类时区分叉。
  4. ⚠️ 它是一张**新的事实派生表**：按本仓规矩，「口径只在 `shared/metrics.ts`」，
     汇总表里只准存**原始列的和**（四项 token / calls / lo / hi），**不准存派生指标**
     （缓存命中率、均价、金额一律查询期现算）。
  5. ⚠️ 受控 DDL 变更 = 新 schema 版本（v8）+ 显式迁移 + checksum；
     按 `AGENTS.md` 的规矩**不能自愈**。这是一个独立立项的工作量。

### 5.4 ★★ `assertLegacyIdentityView()` 不再每请求跑

- **收益**：3M 行 **363 ms/请求**（100 万行 186ms）。它只服务 `identity_view=legacy`。
- **代价**：低。改法三选一：
  1. 只在**确实请求 legacy 视图**时跑（`identity_view=member` 直接跳过）；
  2. 把「已知干净」记在进程内，按 `portal_identity_state.revision` 失效；
  3. 把服务端默认值从 `legacy` 改成 `member`（⚠️ 对外契约变更，需要评估）。
- **现状**：看板页面已用 `identity_view=member`，**手写请求 / 老客户端**会踩到。

### 5.5 ★★ 明细分页去掉全窗口 `COUNT(*)` + 排序

- **收益**：`records:100` 在 3M 行 560ms，其中 `COUNT(*)` 17ms、
  `ORDER BY ... LIMIT 100` **387ms**（全窗口 filesort）。
- **改法**：
  - 加 `(ts DESC, seq DESC, event_id DESC)` 索引（能消除 filesort，代价 +~0.35GB/3M 行）；
  - 或改成**键集分页**（用上一页最后一行的 `(ts, seq, event_id)` 做游标），
    彻底不需要排序与 `OFFSET`；
  - `total` 改成「上限 + 是否还有更多」（`LIMIT 1001` 探测），页面本来也不需要精确总数。

### 5.6 ★★ `day` / `hour` 分桶下推到 SQL（需要先锁定时区语义）

- **现状**：24.6 万行回 JS，491ms（3M 行）。
- **为什么现在不能简单下推**：`query.ts` 的注释记录了实测差异 ——
  SQLite 的 `'localtime'` 按操作系统时区、JS 的 `toDayKey()` 按进程 TZ，
  在 `bun test` 下相差 8 小时。
- **可行路径**：给部署加一个**显式的时区偏移配置**（如 `ATR_STATS_TZ_OFFSET`），
  在 SQL 侧用固定偏移分桶（`FLOOR((ts + offset)/86400000)`），
  并断言它与 `toDayKey()` 在本机输出逐位一致；
  或者干脆用 §5.3 的汇总表（它已经把「天」物化好了）。

### 5.7 ★ 去掉 `session_id` 索引或改前缀索引（省空间）

- 3M 行上 `idx_usage_event_session`、`idx_usage_event_provider`、`idx_usage_event_model`
  这些**单列索引在时间窗查询里根本不会被选中**（见 §4.5 的 EXPLAIN），
  但它们各占 ~0.3GB。
- **前提**：先确认没有别的查询依赖它们（候选目录的 `DISTINCT provider` 会用）。
  可用 `performance_schema` 的 `SUM_NO_INDEX_USED` 反查（见附录 B）。

### 5.8 ★ 参数与运维项

| 项 | 现状 | 建议 |
|---|---|---|
| `innodb_flush_log_at_trx_commit` | 1（每次提交 fsync） | 上报库是唯一副本，**保持 1**；若压测显示 COMMIT 是瓶颈（实测均值 5.8ms），再用 `2` 并接受「机器掉电丢 1 秒」 |
| `--pool` 之外的表空间 | 索引 2290MB | 定期 `OPTIMIZE TABLE` 不解决碎片（本表 `free` 只有 4MB） |
| 客户端超时 | 15s（CLI/插件默认） | 闸门优化后 ACK 54ms，余量充足 |
| MySQL 版本 | 8.4.9 | OK |

---

## 6. 线上库实测（2026-10-01，只读盘点）

> 通过 SSH 在服务器上用 `mysql` 客户端跑**只读** SQL 得到（`online-probe.ts`）。
> 线上 MySQL **只监听 `127.0.0.1:3308`**，公网连不上；凭证在服务器的
> `/root/.atr/mysql8-credentials.txt`，本地不持有。

| 项 | 实测值 |
|---|---|
| MySQL | **8.0.40**（专用实例，`utf8mb4_0900_bin`） |
| `innodb_buffer_pool_size` | **512 MB** |
| schema 版本 | **v7**（迁移账本 4 → 5 → 7 全部 completed） |
| 事件总量 | **52 077** 条 / 507 会话 / 6 人 |
| 时间跨度 | 2026-08-21 → 2026-10-01（**40.8 天**） |
| `usage_event` 体积 | data 24.6 MB + **index 52.5 MB = 77.1 MB**（索引是数据的 **2.1 倍**） |
| 整库体积 | 78 MB |
| 供应商 / 模型 | 7 / 19 |
| 身份与配置 | 9 人、8 把凭证、1 个分组、8 条归属、0 条供应商别名、3 条单价 |

### 6.1 ⚠️ 一个必须先纠正的认知：512MB 的 pool 完全够，瓶颈不在 buffer pool

**52 077 行 / 78 MB 的表在 512MB 的 buffer pool 里 100% 常驻**，实测 30 天窗口的
整窗口聚合（服务端计时）：

| 取数 | 服务端耗时 | 返回 |
|---|---|---|
| `totals`（计数 + 四项求和） | **35.6 ms** | 1 行 |
| `COUNT(DISTINCT session_id)` | **37.1 ms** | 1 行 |
| 人员维度聚合 | **79.7 ms** | 491 行 |
| 趋势原始行（全窗口回 JS 分桶） | **20.1 ms** | 51 679 行 |
| 旧视图自检（`DISTINCT` 人） | **48.2 ms** | 6 行 |
| 供应商分组 | **79.9 ms** | 7 行 |
| **按「一天中的小时」聚合** | **65.8 ms** | 24 行 |

⇒ **线上现在的真实问题不是「慢」**（单个取数 20~80ms 服务端时间），
而是「一次看板刷新要打十几个请求、每个请求还带 4 遍 schema 闸门」。
所以优先级是：**闸门（已实现）> 请求数 > 汇总表**。
之前那份「128MB → 1GB 提升 103 倍」是本机开发容器默认配置造成的，
**不代表线上**；线上该做的是「随数据量增长持续复核」（见 §6.3）。

### 6.2 ⚠️ 线上数据形态与我的合成夹具差很多（结论要按真实形态修正）

| 维度 | 我的夹具 | **线上真实** | 含义 |
|---|---|---|---|
| 每人每天上报条数 | 均匀铺开 | **一人一天 31 327 条**（跨 21.9 小时） | 上报是**会话内高频**的，不是均匀的 |
| 突发性 | 无 | 一人 **8 分钟内 9 849 条** | 补报/批量演示会产生尖峰 |
| 平均每会话条数 | ~3 000 | **13.8 条** | 会话数量比我假设的多得多 |
| 30 天窗口占比 | 8.2% | **99.2%**（库只有 41 天） | 线上还没进入「冷热分离」阶段 |
| provider-model 组合 | 12 | 7 个供应商 / 19 个模型 | 分组维度基数更大 |
| 模型 | 合成名 | `deepseek-v4.1-flash`（28 316 条，**54%**）、`deepseek-flash`（20 762，40%） | **两个模型占 94%** |

⇒ 「每会话 13.8 条」意味着**入库请求数比我估的多**：3M 事件按这个形态约
**21.7 万个会话**。但上报是按批（客户端攒批），实际请求数仍远低于会话数。

⇒ 「两个模型占 94%」意味着 `providers` / `models` 候选目录与分组维度都很小，
**汇总表的行数会比最坏估算小很多**（见 §8.2 的实测推算）。

### 6.3 线上该盯的三个数（随数据量增长复核）

| 指标 | 现在的值 | 什么时候要动 |
|---|---|---|
| `usage_event` 总字节 | 77 MB | **超过 `innodb_buffer_pool_size`（512MB）时**升 pool —— 按当前 ~1.9MB/天，约 **7 个月后** |
| `Innodb_buffer_pool_reads / read_requests` | 待看（附录 B） | 持续 > 1% 就说明常驻不住了 |
| 单个看板请求的 SQL 条数 | 闸门优化后 ~30 条/请求 | 见 §4.4 的「一个请求把闸门跑 4 遍」 |

> ⚠️ 上表第 1 行是**用 1.9MB/天的增速外推**（当前 77MB / 41 天）得到的「约 7 个月」，
> 它假设增速不变且不清理历史。真实增速取决于接入人数与模型数，**每季度复核一次**即可。

### 6.4 线上盘点的复现方式

```bash
# 只读，走 SSH + 服务器本地 mysql 客户端（凭证不离开服务器）
bun run packages/server/verify/perf/online-probe.ts --file packages/server/verify/perf/online-inventory.sql
bun run packages/server/verify/perf/online-probe.ts --file packages/server/verify/perf/online-benchmark.sql --bench
```

`online-probe.ts` 自带的**只读闸门**会拒绝除 `SELECT` / `SHOW` / `EXPLAIN` / `WITH` /
会话变量 `SET @x = …` 之外的任何语句 —— 线上库是唯一副本，手滑一次没有东西能还原。

---

## 7. 「单日趋势」与「工作时段分布」——汇总表怎么设计

> 用户提的两个需求：
> ① **选了具体某一天时，仍要看到这一天的趋势**（即日内曲线，不是 1 个点）；
> ② **要按「一天中的具体时间」看消耗**（工作时段分布）。
>
> 这两个需求直接决定汇总表的**粒度**，是设计的第一约束。

### 7.1 先看清现有实现：粒度不是固定的，而是按窗口长度选的

`packages/web-portal/src/types/portal.ts` 的 `bucketFor()`：

```ts
// 今天 / 昨天 → hour；自定义区间跨度 ≤ 2 天 → hour；其余 → day
return period === 'today' || period === 'yesterday' ? 'hour' : 'day'
```

也就是说 **「选具体某一天看趋势」这条路径已经存在，要的就是 `bucket=hour`**——
服务端 `series?bucket=hour` 已经实现了（`stats-route.ts` 只接受 `day` / `hour`）。
所以需求 ① 的准确表述是：**汇总表必须能服务「小时」粒度**，
否则那天就只能退化成一个点（一天的日粒度汇总 = 1 行）。

### 7.2 结论：**按「日历天」汇总的表，永远服务不了这两个需求**

| 需求 | 需要的分桶键 | 按天汇总能不能给 |
|---|---|---|
| 需求 ① 单日趋势 | **日历小时**（`2026-10-01 14:00`） | ❌ 只能给 1 个点 |
| 需求 ② 工作时段分布 | **一天中的第几小时**（`14`，跨所有日期折叠） | ❌ 一天的行被合并，时段信号**永久丢失** |
| 30 天 / 90 天趋势 | 日历天 | ✅ |
| 人员排行 / 供应商分布 / 金额 | 不按时间 | ✅ |

🚨 关键点：**需求 ② 不是「粒度更细的 ①」，而是另一个分桶键**。
它要的是 `HOUR(ts)`（0~23）这个**折叠维度**——把所有日期的同一时刻加在一起。
所以「把汇总表改成小时粒度」也不够：小时粒度若带日期（`date + hour`），
行数是日粒度的 24 倍；若不按需求 ② 的方式存，就得每次回原始表。

### 7.3 方案：**在汇总表里多存一个「时刻」维度，三张表分工**

```
T1  day 粒度   (day, member, provider, model)                        ← 长窗口趋势/排行/分布/金额
T2  hour 粒度  (day, hour, member, provider, model) 仅最近 N 天       ← 单日日内曲线 + 近期时段分布
T3  hod  粒度  (hour, member, provider, model) 全历史折叠             ← 全时段分布（含更早的历史）
```

**T2 / T3 用两种不同的 GROUP BY 同时满足两个需求：**

| 查询 | 怎么查 |
|---|---|
| 需求 ① 某天的日内曲线 | `T2 WHERE day = '2026-10-01' GROUP BY hour` → 24 点 |
| 需求 ② 近期工作时段分布 | `T2 GROUP BY hour` → 24 点（**跨日期折叠**） |
| 需求 ② 全历史时段分布 | `T3 GROUP BY hour` → 24 点（**一次建成，长期可用**） |

⇒ **时段分布不需要第三张"新概念"表**：`T3` 就是 `T2` 去掉日期维度后的形态，
它把「所有日期的同一时刻」提前折叠好，行数上界是 `24 × 人 × 组合`（与天数无关）。
实测 300 万行 / 300 人时 `T3` 只有 **115 200 行**（见 §8.2）。

⚠️ `T3` 的取舍：折叠掉日期之后，**「工作日时段分布」这种带星期细分的问法就答不了**
（它只知道"14 点"，不知道"哪个星期几的 14 点"）。若要按工作日/周末拆分，
`T3` 需要加一列 `weekday TINYINT`（行数 ×7，仍然很小）—— 这是 §7.6 的开放问题之一。

### 7.4 路由规则（查询层唯一要记住的一张表）

| 窗口 | 分桶 | 走哪张 |
|---|---|---|
| 空窗 / 今天 / 昨天 / ≤2 天 | `hour` | **T2**（未覆盖则退原始表） |
| 3 天 ~ N 天 | `day` | **T1** |
| 工作时段分布（任意窗口） | `hour`（折叠） | **T2** 覆盖部分 + 原始表补更早的部分 |
| `sessions` 去重计数、明细 `records` | — | **永远走原始表**（不可加，见 7.5） |
| `pricing` / 人员目录 / 分组目录 | — | 不碰 `usage_event` |

★ 路由的判定输入必须与 `bucketFor()` **同源**，否则会出现
「页面要小时粒度、服务端给日粒度」这种静默错位（图上只是少了很多点）。

### 7.5 汇总表的语义边界（必须在实现前钉死）

| 项 | 规则 |
|---|---|
| **存什么** | 只存**原始列的和**：`calls`、四项 token、`lo` / `hi`；**绝不存派生指标**（命中率、均价、金额一律查询期现算）—— 这是本仓铁律 1 |
| **`sessions` 不可加** | 去重会话数不能按天相加（跨天会话会被算两次）。`sessions` 要么走原始表，要么接受「按天去重后求和」的口径并**在页面上说明它是估计值** |
| **时间键必须在 JS 侧算** | `day` / `hour` 的本地化只能用 `aggregate.ts` 的 `toDayKey()` / `toHourKey()`。**绝不能用 SQL 的 `strftime` / `DATE(FROM_UNIXTIME())`** ——那正是 `query.ts` 花大力气避开的时区分叉；入库时也必须用**同一个实现**算 `day` / `hour`，否则汇总与原始两条路径的分桶会对不上 |
| **时区变了要能重建** | 与 `local-rollup.ts` 的 `timezoneKey()` 同款：把 `TZ` + 系统时区纳入汇总表版本，变了就重建（本地库已有先例，照抄即可） |
| **金额按查询期现算 + 事件时刻取价** | 换价那一刻两侧各用各的价。汇总行若跨了换价时刻，**不能用它的总量 × 一个价** —— 要么汇总表里按 `(provider, model)` 存 token（即 §5.3 的粒度），要么金额路径继续走原始表 |
| **归属** | 汇总表存 `member_id`（稳定 ID），**分组（多对多）在查询期 JOIN `member_group_assignments` 展开** —— 把分组写进汇总行会让一个事件复制成多行、`SUM` 静默放大 |
| **不可自愈** | 新表 = 新 schema 版本（v8）+ 显式迁移 + checksum；照 `AGENTS.md` 的规矩，**绝不自动重建** |

### 7.6 需要在实现前定下来的四件事（Open Questions）

1. **「最近 N 天」取多少？** T2 的保留窗口决定行数与查询覆盖。
   建议 **90 天**：覆盖「最近一个季度的工作时段分布」与「最近某天的曲线」。
2. **「工作时间段」要不要工作日/周末维度？**
   若要，T2 加一列 `weekday TINYINT`（0~6），行数 ×7 但仍很小；
   若不要，就只按 `hour` 折叠。
3. **时区**：`day` / `hour` 都按**服务器进程的本地时区**（与 `toDayKey()` 一致）。
   跨时区团队需要显式配置并写进汇总表版本键 —— 这件事必须先定，否则改一次要全量重建。
4. **`sessions` 的口径**：接受「按天去重后求和」的估计值（快），还是一律回原始表（准）？
   页面上必须能区分这两者。

---

## 8. 「300 万调用」到底会怎么样

按 300 万事件 / 年（= 8.2k/天，30 天窗口 24.6 万行，表 3.72GB）：

| 问题 | 结论 |
|---|---|
| **入库** | **不会有问题**。100 人每天 10 次上报 = 0.012 req/s，而单实例串行能力 818~3360 条/秒。ACK 从 208ms 再降到 54ms（闸门缓存）后，客户端余量充足 |
| **看板刷新** | **会明显变慢**：单个统计接口 330~890ms，一个页面要打 3~5 个接口 ⇒ **1~3 秒**；`overview` 这种要 `totals + sessions + costTotals + unattributed` 的会到 1.4 秒 |
| **谁能救它** | ① buffer pool 配够（否则 20 秒级）；② 闸门批量化（已实现）；③ 汇总表（把 330~500ms 压到 1ms） |
| **什么时候必须上汇总表** | 当「30 天窗口行数 × 8µs/行」> 可接受延迟时。实测 24.6 万行 ≈ 400ms 是当前形态的天花板；**建议在总事件量超过 500 万（表 > 5GB）或看板 p95 > 2s 时立项** |
| **存储** | 3M 行 3.72GB/年；**5 年就是 18.6GB**（还需 + 索引膨胀）。要提前定归档策略（按年分区 / 冷热分离），否则 buffer pool 永远追不上 |

### 8.1 按线上真实形态重算「什么时候必须上」

线上形态：**52 077 条 / 41 天 / 6 人**，单窗口聚合 20~80ms。
按「每天约 1 900 条（去掉那 5 万条突发）」的稳态推算：

| 规模 | 30 天窗口行数 | 表体积 | 预期单接口 | 结论 |
|---|---|---|---|---|
| 现在（5.2 万） | 5.2 万（41 天全量） | 77 MB | 20~80 ms | ✅ 无需汇总表 |
| 100 万/年 | ~8.2 万 | 1.5 GB | ~150 ms（pool 够时） | ✅ 够用 |
| 300 万/年 | ~24.6 万 | 3.7 GB | ~400 ms | ⚠️ 开始难受，池要跟上 |
| 1000 万/年 | ~82 万 | ~12 GB | 1.5~3 s | 🚨 必须上汇总表 |

### 8.2 汇总表的行数与收益（**实测**，按线上同形数据）

我把种子数据改成线上形态（**7 供应商 / 19 模型、两个主力模型占 94%**）后，
造 300 万行 / 365 天 / 300 人，建三张候选表实测（`probe-rollup-design.ts`，2GB pool）：

| 表 | 粒度 | 行数 | 体积 | 构建 | 相对原始表 |
|---|---|---|---|---|---|
| 原始 `usage_event` | — | **3 000 000** | 3 659 MB | — | 1× |
| **T1** `rollup_day` | (天, 人, 供应商, 模型) | **10 634** | **2.52 MB** | 41 s | **282× 更小** |
| **T2** `rollup_hour_recent` | (天, 小时, 人, 供应商, 模型)，近 30 天 | **11 900** | **3.52 MB** | 1.5 s | — |
| **T3** `rollup_hod` | (小时, 人, 供应商, 模型)，全历史折叠 | **115 200** | 0.02 MB* | 17 s | — |

\* T3 的体积是 `data_length` 单值（主键索引未计入 `table_rows` 估算），实际以行数为准。

**查询收益（p50，同机同数据集对照）**：

| 用例 | 原始表 | 汇总表 | 提升 |
|---|---|---|---|
| 30 天 `totals` | 325.0 ms | **1.7 ms** | **191×** |
| 30 天 `series`（按天） | 331.9 ms | **0.8 ms** | **415×** |
| 30 天人员排行 | 374.4 ms | **1.0 ms** | **374×** |
| 30 天供应商分布 | 388.1 ms | **0.8 ms** | **485×** |
| **单日 `series`（按小时）** | **12.8 ms** | 0.5 ms | 26× |
| **时段分布**（按小时折叠，全历史） | **976.8 ms** | **19.1 ms** | **51×** |
| 时段分布（仅近 30 天） | 54.4 ms | 3.6 ms | 15× |

（单日窗口取的是**中间日**（2026-04-01，8 220 条），不是最后一天 ——
造数按时间顺序铺开，最后一天只有尾巴，拿它测会得到「单日 0.4ms」的假证据。）

#### 🚨 这些行数怎么读（实测的边界，必须说清）

- **T1 的 10 634 行是「上界公式」的一个实例**：行数 = `人数 × 每人每天用到的不同 (供应商,模型) 组合数 × 天数`。
  我的夹具里**每人每天只用到 1 个组合**（事件按会话聚集），所以
  `300 × 1 × 365 ≈ 10 950`，与实测 10 634 吻合。
- 若每人每天用到 12 个组合，同样的 300 人 / 365 天就是 **~131 万行**（约 300 MB）——
  仍然只有原始表的 1/2.3，但比 2.5 MB 大两个数量级。
  **所以「汇总表有多大」完全由「每人每天用到几个组合」决定。**
- ✅ **这一项已在线上复核（2026-10-01）**：`C` 的均值是 **1.67**（最大 7，
  65.5% 的人-天只用 1 个组合）。据此外推 **T1 在 300 人 / 365 天 ≈ 18.3 万行**，
  T2（30 天）≈ 4 万行（上界 9.8 万）——
  **落在小的一侧，T2 的 30 天窗口可以放心用。**
  复核 SQL 与完整分布见 `docs/汇总表设计规格.md` §6。
- 线上实测给出一个参考：**6 人 × 41 天 × C = 97 行 ⇒ C ≈ 0.39**，
  也就是线上真实形态下「每人每天用到的组合数」**不到 1**（多数人一天只用一个模型）。
  按这个形态，T1 在 300 人 / 365 天大约只要 **几千到一万行**。
- ⚠️ **一个被夹具坑过的指标**：我前几轮的造数脚本**没有建任何分组**，
  于是 `by=group` 走的是「关联表返回空集」的最快路径（实测 0.46ms）。
  在夹具补上「1 个分组 + 所有人挂进去」之后，同一个查询变成 **85ms**
  （对比 `by=user` 61ms）—— 也就是说**之前的「分组排行很快」是假数字**。
  这条已修正到夹具里（`seed.ts` 现在会建组并在建人时带上 `group_ids`），
  报告里原有的 `groups(group)` 数字请以这条为准。
- T2 也一样：夹具里每人每小时只有 1 个组合，实测 11 900 行；换成人多用多模型会成倍增长。
  **这就是 §7.6 要把「T2 保留窗口」定成 7~30 天而不是 90 天的原因。**
- T3（时段折叠）行数上界是 `24 × 人 × 组合`，与天数无关：300 人 / 12 组合 = **86 400 行**，
  实测 115 200（因为夹具的 provider-model 组合基数比 12 略大）。它**永远很小**，
  而且**一次建成长期可用**（时段分布不随新数据失效）。

#### 结论（对两个需求的直接回答）

| 需求 | 走哪张表 | 实测 |
|---|---|---|
| 具体某天的**日内曲线** | 原始表就够（12.8 ms），要更快就 T2 | 原始 12.8 ms → T2 0.5 ms |
| **工作时段分布** | T3（全历史）或 T2（近 N 天） | 原始 976.8 ms → **T3 19.1 ms（51×）** |
| 30 天趋势 / 排行 / 分布 / 金额 | T1 | 300~490 ms → **~1 ms（191~485×）** |

⇒ **「按天汇总」的服务不了的正是这两个需求；T2/T3 是把「小时」这一维显式存下来，
一行 SQL 就同时解决它们，而体积只有 3 MB 量级。**

---

## 9. 落地顺序（建议）

| 阶段 | 动作 | 预期收益 | 风险 |
|---|---|---|---|
| **P0（今天就能做）** | ① 线上复核 buffer pool（现在 512MB / 表 77MB，**暂时够**）② 把闸门批量化部署上去 | 轻请求 4~5×；SQL 13× | 低（1459 测试全绿 + 64 项对账） |
| **P0（已实现）** | schema 闸门批量化 | 轻请求 4~5×；SQL 13× | 低（测试全绿） |
| **P1** | `assertLegacyIdentityView()` 按视图 / 按 revision 缓存 | 363ms/请求 | 低 |
| **P1** | 明细去 `COUNT(*)` + 键集分页 | 387ms → 数 ms | 中（改分页契约） |
| **P2** | 汇总表（**已实现**，schema v8） | SQL 层 **193×~1862×**；端到端在本机 **1.0×**（固定开销主导）→ 见下 | 高（受控 DDL + 迁移 + `sessions` 语义）—— 设计与四项决定已定稿：`docs/汇总表设计规格.md` |
| **P2** | 时间桶下推到 SQL（需时区配置） | ~490ms → 数 ms | 中（口径） |

---

## 附录 A：复现命令

```bash
# 0. 造数（隔离库，自己创建 / 自己删除；状态落在 .artifacts/perf/）
bun run packages/server/verify/perf/seed.ts --scale 1e5 --members 200 --days 365
bun run packages/server/verify/perf/seed.ts --scale 1e6 --events 1000000 --members 200 --batch 3000
bun run packages/server/verify/perf/seed.ts --scale 3e6 --events 3000000 --members 300 --batch 3000 --order ordered

# 1. 瓶颈一：buffer pool 对照
#    ① 单条 SQL（128MB vs 1GB）
bun run packages/server/verify/perf/probe-pool.ts --scale 1e6
#    ② ★ 端到端端点（1/2/4GB）—— 「一个请求里连续跑多个全窗口查询」的坑只有这里看得见
bun run packages/server/verify/perf/probe-endpoint-pool.ts --scale 3e6 --repeats 3

# 2. 瓶颈二：闸门逐条计时（回答「一次 openPortalStore 跑了几条、各多久」）
bun run packages/server/verify/perf/probe-gate-trace.ts --scale 1e6
bun run packages/server/verify/perf/probe-gate.ts --scale 3e6 --pool 1024

# 3. 逐操作取数耗时（真实门面函数，客户端视角）
bun run packages/server/verify/perf/probe-ops.ts --scale 3e6 --repeats 8 --pool 1024

# 4. 全套 HTTP（含入库 ACK 与 21 个端点）
bun run packages/server/verify/perf/bench.ts --scale 1e6 --pool 1024 --repeats 3
#    冷启动（每个用例前 FLUSH TABLES）
bun run packages/server/verify/perf/bench.ts --scale 1e6 --pool 1024 --repeats 1 --cold

# 5. 单请求 SQL 条数与指纹（performance_schema，服务端自己数）
bun run packages/server/verify/perf/profile-request.ts --scale 1e5

# 5b. ★ 单请求内的**重复语句**（一次请求 = 一个统计周期；查出闸门被跑了 4 遍）
bun run packages/server/verify/perf/probe-request-dup.ts --scale 1e5

# 6. 优化方案的 A/B（进程内打桩，不改源码；跑完恢复 buffer pool）
bun run packages/server/verify/perf/ab-optimize.ts --scale 1e6 --repeats 8 --pool 1024

# 7. 汇总表候选
bun run packages/server/verify/perf/probe-rollup.ts --scale 3e6 --pool 1024
# 7b. ★ 汇总表**设计**验证（三张候选表的行数/体积/收益，按线上同形维度基数）
bun run packages/server/verify/perf/probe-rollup-design.ts --scale 3e6 --pool 2048 --recent-days 30

# 8. 固定开销分层（HTTP 回环 / 鉴权 / 库各占多少，用来排除「测的是环境不是应用」）
bun run packages/server/verify/perf/probe-overhead.ts --scale 1e5 --repeats 30

# 9. 用完清掉隔离库
bun run packages/server/verify/perf/seed.ts --scale 1e6 --dispose
bun run packages/server/verify/perf/seed.ts --scale 3e6 --dispose
```

⚠️ 脚本都会自己校验连接串的库名以 `atr_http_v5_` 开头，**拒绝在非隔离库上操作**。
`probe-*` 系列只读写自己的隔离库；`bench-all` / `probe-pool` / `ab-optimize` / `probe-rollup`
会临时改 `innodb_buffer_pool_size`（全局动态变量）并**在结束时恢复原值**。
`mysql-root.sh` 是 `probe-gate*` / `profile-request` 用 root 读 `performance_schema` 的辅助脚本，
需要先 `docker cp` 进容器（容器名 `local-database-review-mysql`，本机开发实例）。

## 附录 B：怎么在线上复核这三条

1. **buffer pool 够不够**：
   ```sql
   SHOW STATUS LIKE 'Innodb_buffer_pool_read%';   -- reads/read_requests 应 < 1%
   SELECT ROUND((data_length+index_length)/1024/1024) AS mb FROM information_schema.tables
    WHERE table_schema=DATABASE() AND table_name='usage_event';
   ```
2. **闸门占了多少**：打开 `general_log` 打一个请求，数 `information_schema` 语句条数
   （优化前 ~116，优化后 ~8）。
3. **哪些索引真的被用了**：
   ```sql
   SELECT DIGEST_TEXT, COUNT_STAR, SUM_NO_INDEX_USED, SUM_ROWS_EXAMINED
     FROM performance_schema.events_statements_summary_by_digest
    WHERE SCHEMA_NAME=DATABASE() ORDER BY SUM_ROWS_EXAMINED DESC LIMIT 20;
   ```

## 附录 C：本次改动清单

| 文件 | 改动 |
|---|---|
| `packages/core/src/db/portal-migrations.ts` | `verifyCurrent()` 的 MySQL 分支改为 `verifyCurrentMysql()`：全库批量目录核对（116 条 → 8 条语句）。**只改「怎么取目录」，不改「比什么」**，并经双后端逐位对账 |
| `packages/server/verify/perf/lib-seed.ts` | 造数器（固定种子、真实写入路径、可按时间顺序或随机到达） |
| `packages/server/verify/perf/seed.ts` | 隔离库生命周期：建库 / 增量灌数 / 删库；状态落 `.artifacts/perf/<scale>.json` |
| `packages/server/verify/perf/bench.ts` | 端到端 HTTP 压测：入库 ACK/吞吐 + 21 个 stats 端点；支持 `--pool` / `--cold`；带热身与 pool 稳定性校验 |
| `packages/server/verify/perf/bench-all.ts` | 同一规模下多档 buffer pool 的逐条 SQL 对照矩阵 |
| `packages/server/verify/perf/probe-pool.ts` | 瓶颈一（单条 SQL）：128MB vs 1GB |
| `packages/server/verify/perf/probe-endpoint-pool.ts` | 瓶颈一（端点级）：1/2/4GB，抓出「1GB 够单条查询、不够一个请求连跑 10 趟」 |
| `packages/server/verify/perf/probe-gate.ts` / `probe-gate-trace.ts` | 瓶颈二：闸门的语句条数与逐条耗时 |
| `packages/server/verify/perf/profile-request.ts` | 单请求的 SQL 指纹分布（`performance_schema`） |
| `packages/server/verify/perf/probe-request-dup.ts` | 单请求内的**重复**语句（查出闸门被跑 4 遍） |
| `packages/server/verify/perf/probe-ops.ts` | 逐个门面方法的真实客户端耗时 |
| `packages/server/verify/perf/probe-rollup.ts` | 汇总表候选（含 `sessions` 不可加的语义说明） |
| `packages/server/verify/perf/probe-rollup-design.ts` | ★ 汇总表**设计**验证：T1 日粒度 / T2 小时近 N 天 / T3 时段折叠 的行数、体积、构建与查询收益 |
| `packages/server/verify/perf/online-probe.ts` | ★ 线上库**只读**探查：SSH + 服务器本地 mysql，带只读闸门；`--bench` 用服务端时钟逐条计时 |
| `packages/server/verify/perf/online-inventory.sql` | 线上盘点 SQL（版本 / 体积 / 索引 / 身份 / 用量分布） |
| `packages/server/verify/perf/online-benchmark.sql` | 线上看板取数 SQL 基准 + **按小时折叠的时段分布** |
| `packages/server/verify/perf/ab-optimize.ts` | 优化方案的 A/B（进程内打桩，不改源码）；跑完恢复 buffer pool |
| `packages/server/verify/perf/probe-overhead.ts` | 固定开销分层（排除「测的是环境不是应用」） |
| `packages/server/verify/perf/mysql-root.sh` | 读 `performance_schema` 的 root 辅助脚本（需要 `docker cp` 进容器） |

> 性能夹具不进 `bun test`（它们要真 MySQL 与几十秒到几分钟的运行时），
> 与 `verify-mysql-portal.ts`、`verify-ingest-performance.ts` 同类。
> 它们都自己校验隔离库名（`atr_http_v5_*`），**拒绝在非隔离库上操作**。
