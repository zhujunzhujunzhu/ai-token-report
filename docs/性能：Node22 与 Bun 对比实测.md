# 性能：Node 22 与 Bun 对比实测（部门服务端）

> 本文是**实测报告**，不是设计文档。全部数字来自生产机 `117.72.173.21` 上的
> **同机、同库、同产物**对照：同一个 `dist/main.mjs`，同一份克隆的生产数据，
> 只换运行时。夹具在 [`packages/server/verify/perf/runtime-ab/`](../packages/server/verify/perf/runtime-ab/README.md)。
>
> 一句话答案：**换 Bun 不会让看板变快（瓶颈是 MySQL），但会省掉约 1/6 的 CPU 和一半的内存，
> 并且要绕一个 Bun 自己的 MySQL 认证缺陷。**

---

## 0. 结论速览

| # | 结论 | 实测数字 |
|---|---|---|
| 1 | ✅ **Bun 1.4.2 曾连不上线上 MySQL，现已修在代码里**（自动按需启用 TLS，部署者无需改连接串） | 修复前 `errno 1045`；修复后 `atr_user`（32 字节口令）**不带任何 TLS 参数**连上 |
| 2 | ★ **CPU 省约 1/6** —— 这是最稳的结论，两轮之间只差 0.6% | **81.4 → 66.9 ms/请求（−17.8%）** |
| 3 | ★ **常驻内存减半** | RSS 起始 **154.3 → 70.3 MB（−54.4%）**；结束 269.1 → 117.7 MB |
| 4 | ★ **启动快约三成** | 到就绪 **0.65 → 0.45 s（−30%）** |
| 5 | ⚠️ **看板延迟基本不变** | DB 边界端点差异在 **±6% 内**，被两轮抖动盖住（这些请求 80%+ 时间在等 MySQL） |
| 6 | ★ **但「要搬大量行回 JS」的端点明显更快** | 趋势 `series:day30` **−14.5%**、`series:stack-model` **−18.7%**、`breakdown:day` **−18.5%** |
| 7 | ★ **静态资源更快** | 首页 **−53%**、157 KB 入口 JS **−23%** |
| 8 | ⚠️ **上报路径没有收益** | 吞吐 1090 → 1099 条/秒（噪声内）；ACK p50 176.9 → 176.1 ms |
| 9 | ✅ **换驱动不改任何数字** | 24/24 端点响应体**逐字节相同**；上报 ACK、判重语义、写入后合计全同 |
| 10 | ⚠️ **`?tls=true` 这个绕过的代价** | **+3.3% CPU**，约吃掉 Bun 优势的 1/5（单轮测量） |

**所以：如果目标是「让看板更快」，换 Bun 不是手段** —— 瓶颈在 MySQL 与每请求跑多遍的
schema 闸门（见 [MySQL 上报库摸底](性能：MySQL上报库摸底与优化方案.md)）。
**如果目标是「省资源、留余量」，Bun 值得换**：这台机器只有 2 vCPU / 3.7 GB 内存。

---

## 1. 先说结论之外的那件事：Bun 连不上线上库

这是本次实测**第一个**撞上的问题，也是决定「能不能换」的前提。用服务器上的 Bun 1.4.2
直连线上 MySQL 只读探针：

```
BUN_MYSQL_FAIL MySQLError Access denied for user 'atr_user'@'localhost' (using password: YES)
  errno=1045 code=ERR_MYSQL_SERVER_ERROR
```

同一个连接串交给 Node 22 + `mysql2`：正常，读到 `52 119` 条事件。

### 1.1 边界钉在哪（实测矩阵）

在同一个 MySQL 实例上建两个 `caching_sha2_password` 用户，只差口令长度：

| 口令长度 | 非 TLS | TLS |
|---|---|---|
| 16 字符 | ✅ 成功 | — |
| **32 字符（= 线上 `atr_user`）** | ❌ **errno 1045** | ✅ **成功** |

`SHOW VARIABLES LIKE 'have_ssl'` → `YES`（MySQL 8 自带自签证书）。

⇒ 这就是本仓 `packages/core/src/db/mysql.ts` 里已经记下的
[oven-sh/bun#26195](https://github.com/oven-sh/bun/issues/26195)：
Bun 的 MySQL 原生驱动在**非 TLS** 连接下对 `caching_sha2_password` +
口令 > 19 字符走的是有缺陷的那条全量认证分支。
更准确地说，边界是「口令装不下一个 20 字节的 scramble」——**与口令强度无关**。

### 1.2 已修在代码里：不需要动 `ATR_MYSQL_URL`

**本仓已把这个绕过做进 `openMysqlBackend()`**（`packages/core/src/db/mysql.ts` 的
`planBunMysqlAuth()`）：当运行在 Bun、且连接串的口令 ≥ 20 **字节**、且 URL
既没要求也没禁止 TLS 时，**自动给这个连接加上 `tls: true`**。

⇒ **部署者什么都不用改**，原来的连接串照用：

```
ATR_MYSQL_URL=mysql://atr_user:***@127.0.0.1:3308/ai_token_report
```

三个刻意的取舍：

| 取舍 | 为什么 |
|---|---|
| **只在「否则必然失败」的那一档动手**（口令 ≥ 20 字节） | 短口令时 Bun 的非 TLS 路径本来就正常，没有必要替使用者改变传输方式 |
| **尊重 URL 的显式选择**（`?ssl-mode=DISABLED` / `?tls=false` 不覆盖） | 那是使用者的明确决定；而且「服务端没开 TLS」时强制 TLS 会把一条本来能用的连接弄坏 |
| **在启动横幅里说出来** | 否则运维看到「MySQL xxx @ host:port」会以为连接还是明文的，而传输方式已被换掉 |

横幅形如：`上报库    MySQL ai_token_report @ 127.0.0.1:3308（Bun 长口令：已自动启用 TLS）`

> 🚨 **不要用「把口令缩短到 ≤19 字符」来绕。** 那等于为了一个上游驱动缺陷
> 降低数据库凭证强度，而且那段诊断文案（`BunMysqlAuthenticationCompatibilityError`）
> 已经明确写了不建议这样做。连接本来就是 `127.0.0.1` 回环，TLS 的代价（见 §8）是可接受的。

**这道修复的证据**（两层，都在真库上跑过）：

| 层 | 位置 | 覆盖 |
|---|---|---|
| 判定逻辑（不连库） | `packages/core/test/mysql-auth.test.ts`（12 条） | 19/20 字节边界、UTF-8 字节 vs 字符、百分号转义、显式选择、坏输入 |
| 横幅文案（不连库） | `packages/server/test/portal-target-label.test.ts`（7 条） | 加后缀、不带口令、Node/短口令不加后缀、前缀与原函数逐字相同 |
| **活体（真 MySQL + 真驱动）** | `bun run --filter '@ai-token-report/server' verify:mysql:bun-auth` | 19 字节明文能连、20 字节靠自动 TLS 能连、**把修复关掉必须复现出 1045** |
| 线上真实凭证 | 见下方实测记录 | `atr_user` 口令 32 字节，**不带任何 TLS 参数**成功连上线上库 |

线上实测结果（`117.72.173.21`，`SELECT COUNT(*)` 只读）：

```
[4] ★ 20 字节（边界外侧）：自动 TLS 必须让它连上
  ✅ 连接成功（读到 52652 条事件）
[5] 对照：显式 ssl-mode=DISABLED（= 修复前的行为）
  ✅ 仍然失败（说明上面那条成功确实来自修复）：errno=1045
[6] 线上真实凭证 atr_user（32 字节）
  ✅ 不带任何 TLS 参数即可连接（读到 52652 条事件）
结果：13 通过 / 0 失败（bun 1.4.2）          ← Node 侧 10 通过 / 0 失败（行为未变）
```


---

## 2. 测试方法（为什么这些数字可信）

| 项 | 做法 | 为什么 |
|---|---|---|
| 被测产物 | **HEAD 构建的 `packages/server/dist/main.mjs`（970 884 B），两个运行时用同一份** | 比的必须是「同一个应用的两种运行时」，不是两份代码 |
| 上报库 | `mysqldump --single-transaction` 把生产库 `ai_token_report` **整份克隆**到隔离库 `atr_http_v5_bench` | 合成夹具的维度基数、会话分布、时间跨度都不真实；直接压生产库又要写事件、要凭证 |
| 凭证 | 在**克隆库**里插一把已知明文、挂在内置 `admin` 角色上、授予全部 16 个权限码的 appKey | 生产库的凭证只有摘要，明文拿不到；而写生产库不可接受 |
| 轮次 | **交替 4 轮：node → bun → node → bun** | 只跑一轮的话，第一轮撞上冷页缓存，会被读成运行时的差异 |
| CPU 亲和 | server 钉 CPU 0、压测客户端钉 CPU 1（`taskset`） | 2 核机器上不钉的话，两者互相抢核，且抢法逐轮变化 |
| 主指标 | 服务端进程 `/proc/<pid>/stat` 的 `utime+stime` ÷ 请求数 | 它不受客户端调度、网络、MySQL 排队影响；而墙钟 p50 里 80%+ 是等 MySQL |
| 正确性 | `parity.mjs` 让两个实例**同时**跑，逐个端点**逐字节**比响应体 | 换的是 MySQL 驱动（`Bun.sql` vs `mysql2`），「数字会不会变」必须先钉死 |
| 安全 | 隔离库名必须以 `atr_http_v5_` 开头；用完 `dispose` 全删 | `DROP DATABASE` 写错一个名字 = 全员历史用量永久消失 |

> ⚠️ **测的是 HEAD，不是线上正在跑的那份产物。** 线上 `dist` 是 `2026-09-30 23:24` 的构建；
> 那份之后还落了「看板数据范围收窄」「趋势按用户/模型分层」两批改动
> （涉及 `stats-route.ts` / `portal.ts` / `query.ts` / `protocol.ts`）。
> **两个运行时之间是同一份产物，所以对照是有效的**；绝对值对应的是 HEAD。
> 要复核线上那份，用 `ATR_AB_ART=/data/ai-token-report/packages/server/dist/main.mjs bash run.sh node:1 bun:1`。

### 2.1 实测环境

| 项 | 值 |
|---|---|
| 主机 | Linux 3.10.0（CentOS 7 系）/ 2 vCPU Intel Xeon Gold 6267C @ 2.60GHz / 3 757 MB 内存 |
| Node（线上实际用的） | **v22.21.1**，`/usr/local/node22/bin/node` |
| Bun | **1.4.2**，`/usr/local/bin/bun`（服务器上早就装了，另有一个 `bun-demo` pm2 应用） |
| pm2 | 7.0.4；`ai-token-server` 是 `fork` 模式 + `interpreter /bin/bash`，跑 `deploy/atr-server-start.sh` |
| MySQL | **8.0.40**，专用实例，只监听 `127.0.0.1:3308`，`innodb_buffer_pool_size = 512 MB` |
| 数据 | `ai_token_report` 共 **78 MB**；`usage_event` **77.1 MB**（data 24.6 + index 52.5）；**52 132 条**事件 / 9 人 / 8 凭证（克隆时的快照） |
| 缓冲池命中 | `Innodb_buffer_pool_reads / read_requests` = 1 101 / 7 836 665 201 ≈ **0.000014%** |

> 最后一行很重要：**整张表 100% 常驻缓冲池**，所以本次差异**不是磁盘 I/O 差异**，
> 而是「运行时 + MySQL 驱动」这两层的差异。
>
> 另外 `pm2 -v` 报的是 node **v20.19.2**（pm2 自己的解释器），
> 但被托管的 `ai-token-server` 由启动包装脚本 `exec` 成 **node22** —— 两件事，别混。

---

## 3. 主指标：服务端 CPU / 请求

| 指标 | Node 22 各轮 | Bun 各轮 | Node 中位 | Bun 中位 | 差 |
|---|---|---|---|---|---|
| **CPU ms / 请求（全部 842 个请求）** | 82.363 / 80.521 | 67.073 / 66.635 | **81.4** | **66.9** | **−17.8%** |
| CPU ms / 顺序 stats 请求（各 625 个） | 86.032 / 84.272 | 70.96 / 70.48 | 85.2 | 70.7 | −17.0% |
| CPU ms / 上报请求（各 40 个） | 55.25 / 54.5 | 46.75 / 44.0 | 54.9 | 45.4 | −17.3% |
| 服务端 CPU 总计 (s) | 69.35 / 67.96 | 57.28 / 56.84 | 68.7 | 57.1 | −16.9% |

★ **同运行时的两轮差异只有 0.6%（bun）/ 2.2%（node），而跨运行时是 17.8%** ——
这个差异远在噪声之上，是本次最可靠的结论。

---

## 4. 内存与启动

| 指标 | Node 22 各轮 | Bun 各轮 | Node 中位 | Bun 中位 | 差 |
|---|---|---|---|---|---|
| **RSS 起始 (MB)** | 155.0 / 153.5 | 70.1 / 70.5 | **154.3** | **70.3** | **−54.4%** |
| RSS 结束 (MB) | 223.0 / 315.3 | 116.2 / 119.1 | 269.1 | 117.7 | −56.3% |
| RSS 峰值 (MB) | 226.1 / 321.4 | 211.1 / 227.2 | 273.8 | 219.1 | −20.0% |
| 线程数 | 11 / 11 | 7 / 7 | 11 | 7 | −36.4% |
| **启动到就绪 (s)** | 0.555 / 0.746 | 0.497 / 0.412 | **0.651** | **0.455** | **−30.1%** |

> 线上此刻的真实占用供参照：`ai-token-server` pid 3825，运行 10 小时，RSS **约 90–160 MB**，11 线程
> （空闲时 ~90 MB，被访问后涨到 160 MB 上下）—— 与本报告的 node 数字同量级。

---

## 5. 延迟：哪里变快、哪里不变

两轮 p50 的中位数（毫秒）。**完整 25 个端点见 `report.mjs` 生成的 `REPORT.md`**。

### 5.1 Bun 明显更快的

| 端点 | Node 中位 | Bun 中位 | 差 | 这类端点的共同点 |
|---|---|---|---|---|
| `static:index` | 1.7 | 0.8 | **−52.9%** | 纯静态文件 |
| `static:entry-js`（157 KB） | 10.8 | 8.3 | **−23.1%** | 纯静态文件 |
| `series:stack-model` | 492.8 | 400.5 | **−18.7%** | 1.3 万行回 JS 做分桶 |
| `breakdown:day` | 412.8 | 336.4 | **−18.5%** | 9 千行回 JS |
| `series:stack-user` | 520.5 | 438.1 | −15.8% | 1.3 万行回 JS |
| `series:day30` | 335.4 | 286.8 | **−14.5%** | 1 万行回 JS |
| `health` | 39.9 | 36.5 | −8.5% | 极轻请求（运行时开销占比高） |

⇒ **规律很清楚**：Bun 赢在「HTTP 层 + JSON + 把大量行搬进 JS 再算」这一段。
本仓的时间分桶刻意放在 JS 侧（`aggregate.ts` 的 `toDayKey()`），所以趋势类端点
每次都要把整个窗口的行搬回进程 —— 这正好是 Bun 的强项。

### 5.2 基本不变、或 Bun 略慢的（都在噪声内）

| 端点 | Node 中位 | Bun 中位 | 差 |
|---|---|---|---|
| `breakdown:hour` | 145.9 | 154.3 | +5.8% |
| `overview:today` | 150.2 | 158.8 | +5.7% |
| `members`（候选） | 140.2 | 146.6 | +4.6% |
| `diagnostics` | 227.6 | 236.8 | +4.0% |
| `pricing`（单价快照） | 141.4 | 147.0 | +4.0% |
| `overview:30d` | 371.8 | 385.8 | +3.8% |
| `records:1000` | 273.5 | 282.6 | +3.3% |
| `breakdown:project` | 627.9 | 645.1 | +2.7% |
| `breakdown:provider` | 396.9 | 404.4 | +1.9% |
| `breakdown:user` | 408.8 | 405.9 | −0.7% |
| `breakdown:provider-model` | 414.2 | 412.6 | −0.4% |

⚠️ **这些数字不能当成「Bun 更慢」的证据**：同运行时两轮之间的抖动就有这个量级
（例：bun 的 `members` 是 151.0 / 142.2，自己两轮差 6%；node 的 `RSS 结束` 是 223 / 315 MB）。
它们的共同点是**单个请求里要跑多趟 MySQL 取数**，时间基本花在 DB 里。

---

## 6. 上报与并发

| 指标 | Node 22 各轮 | Bun 各轮 | 差 |
|---|---|---|---|
| 上报吞吐（200 条/批 × 40 批） | 1096 / 1084 条/秒 | 1089 / 1109 条/秒 | +0.8%（噪声内） |
| 上报 ACK p50 | 176.4 / 177.4 ms | 177.2 / 174.9 ms | −0.5%（噪声内） |
| 上报 ACK p95 | 221.5 / 217.7 ms | 205.5 / 211.5 ms | −5.1% |

⇒ **上报路径换 Bun 没有收益**。它的 176 ms 花在 schema 闸门 + 鉴权 + MySQL 事务上，
不花在运行时的协议栈上（尽管 CPU/请求仍然是 Bun 低 17%）。

并发（一次看板首屏 = 7 个请求，跑 12 秒，客户端 1 / 4 / 16）：

| 客户端数 | Node req/s | Bun req/s | Node p95 | Bun p95 | 失败 |
|---|---|---|---|---|---|
| 1 | 3.6 / 3.5 | 3.5 / 3.6 | 450 / 452 ms | 463 / 427 ms | 0 |
| 4 | 5.7 / 5.7 | 6.1 / 5.9 | 1403 / 1366 ms | 1145 / 1115 ms | 0 |
| 16 | 4.4 / 4.6 | **5.3 / 5.3** | 4921 / 4608 ms | 4801 / 4625 ms | 0 |

⚠️ 注意 16 客户端时**吞吐反而低于 4 客户端**（两边都如此）—— 这是服务端的饱和点，
与运行时无关：单核上的 CPU 预算 + 每请求多趟 MySQL 往返，排到后面就是等。
Bun 在这个饱和点上高约 **+18%**（与 CPU/请求的结论一致）。

---

## 7. 逐位对账：换驱动不改任何数字

两个实例同时起（node:18901 / bun:18902）指向同一个克隆库，逐个端点比响应体：

| 项 | 结果 |
|---|---|
| 24 个端点响应体**逐字节相同** | ✅ 24 / 24（含 606 KB 的 `records:1000`、带 `stack` 的趋势、单价快照） |
| 上报 ACK | ✅ 两边都是 `{"accepted":50,"duplicates":0,"rejected":0}` |
| 重放同一批的判重语义 | ✅ 两边都是 `{"accepted":0,"duplicates":50,"rejected":0}` |
| 写入之后再看合计 | ✅ 两份 `overview` 响应仍逐字节相同 |

这条是整套结论的前提：Bun 走内建 `Bun.sql`、Node 走 `mysql2`，**两个完全不同的驱动**。
对账通过才说明「§3 的 17.8% 是同一个应用跑得更省，而不是算的东西不一样」。

---

## 8. 自动 TLS 的代价

这条成本**没有消失**，只是从「部署者要记得加 `?tls=true`」变成了「代码替他加」。
同一个 Bun、同一个克隆库，只换 MySQL 用户与是否 TLS（各 1 轮）：

| | 32 字符口令 + TLS（线上形态） | 16 字符口令 + 非 TLS | 差 |
|---|---|---|---|
| CPU ms / 请求 | 68.50 | 66.28 | **+3.3%** |
| CPU ms / 顺序请求 | 71.58 | 69.14 | +3.5% |
| CPU ms / 上报请求 | 48.00 | 45.75 | +4.9% |
| RSS 起始 / 峰值 | 71.0 / 203.4 MB | 67.6 / 207.1 MB | 相当 |

⇒ TLS 约吃掉 Bun 优势的 **1/5**，开完之后 Bun 仍比 Node 低约 **15%** CPU。
（单轮测量，3.3% 与噪声同量级，量级判断可用、精确值不可用。）

> 顺带：TLS 只是**恢复**到能连，不是额外负担 —— 修复前那条路径根本连不上，
> 所以「3.3% 换一个能用的连接」不是取舍，是净得。

---

## 9. pm2 能不能直接托管 Bun

能。**不动生产条目**，另起一个独立 pm2 应用验证（验完即删）：

```
[PM2] Starting /tmp/atr-ab-pm2-start.sh in fork_mode (1 instance)
✓ /api/health          → {"ok":true,...,"schema_version":7,"initialized":true}
✓ /api/v1/stats/overview → HTTP 200  0.448s
✓ /            静态首页  → HTTP 200  0.003s
✓ pm2 restart 之后       → health HTTP 200  0.171s
✓ 生产条目 ai-token-server 全程 online，pid 未变
```

pm2 侧无需任何改动：它托管的本来就是 `deploy/atr-server-start.sh` 这个 **bash 脚本**
（`interpreter /bin/bash`），换运行时只改脚本里的 `exec` 那一行。

---

## 10. 建议

### 10.1 该不该换

| 如果目的是 | 结论 |
|---|---|
| 让看板更快 | ❌ **不该以换 Bun 为主要手段**。DB 边界端点差异在 ±6% 内；真正的瓶颈是 MySQL 取数与每请求多跑几遍的 schema 闸门 —— 见 [MySQL 上报库摸底](性能：MySQL上报库摸底与优化方案.md) §4.4 / §5.3 |
| 省内存、给机器留余量 | ✅ **值得换**。2 vCPU / 3.7 GB 的机器上，常驻从 ~154 MB 降到 ~70 MB |
| 省 CPU / 提高并发上限 | ✅ 值得换（−17.8%）；自动 TLS 会吃掉其中约 1/5（§8） |
| 上报更快更稳 | ❌ 没有收益（吞吐与 ACK 都在噪声内） |
| 少一个 Node 安装、少一层依赖 | ⚠️ 中性：服务器上两者都已存在 |

### 10.2 真要换的话（三步）

1. **确认 Bun 存在并钉版本**：`/usr/local/bin/bun`（当前 1.4.2）。
2. **改 `/data/ai-token-report/deploy/atr-server-start.sh`**：
   `exec /usr/local/node22/bin/node …` → `exec /usr/local/bin/bun …`。
   （该文件**不在仓库里**，只存在于服务器上。）
3. `pm2 restart ai-token-server`，然后按部署脚本同样的口径健检：
   `127.0.0.1:$ATR_PORT/api/health` + 公网 `/ai-token/` 首页与入口 JS 的 MIME；
   并确认启动横幅里的「上报库」那一行出现了 **`（Bun 长口令：已自动启用 TLS）`**。

✅ **`ATR_MYSQL_URL` 不用动** —— §1 的那个认证缺陷已经修在
`openMysqlBackend()` 里（`planBunMysqlAuth()` 按需启用 TLS）。

**回滚**：把第 2 步改回去 + `pm2 restart ai-token-server`。
⚠️ `scripts/deploy-server.mjs` **只管 `dist` 的切换与回滚，不管运行时** ——
所以「换了运行时」这件事必须单独记录，否则下次部署会以为回滚能把它带回去。

### 10.3 换之前值得先做的事

本次实测顺带确认了一件事：**这台机器上最贵的是 MySQL 取数，不是运行时**。
在动运行时之前，先看 [MySQL 上报库摸底](性能：MySQL上报库摸底与优化方案.md) 里那两条
（一个请求把 schema 闸门跑 4 遍、汇总表把全窗口扫描换成查小表），
它们的收益是**量级**，而换运行时是 **17%**。

---

## 11. 未覆盖 / 已知边界

- **没做长稳观察**：只跑了约 20 分钟的高强度压测，没有观察数小时级别的内存增长曲线。
- **没测 pm2 cluster 模式**：线上目前是单实例 fork；多实例共享 MySQL 的争用没覆盖。
- **没测认证插件换成 `mysql_native_password`** 的表现（那会绕开 §1 的缺陷，但改的是库配置）。
- **静态资源量的是 `node:fs/promises`**：本仓硬约束「服务端不得依赖 `Bun.file()`」，
  所以这一项是「Bun 实现 Node fs API 的性能」，不是 Bun 原生静态托管的性能。
- **背景噪声未完全隔离**：压测期间生产服务仍在同一台 2 vCPU 机器上跑，
  对两个运行时是同等的噪声，但没有做到「机器完全空闲」。
- **HEAD 与线上产物有差异**（见 §2），绝对值对应 HEAD。

---

## 附录：复现

```bash
SSH=packages/server/verify/perf/runtime-ab/ssh-exec.mjs
DST=/data/ai-token-report/packages/server/runtime-ab

bun run --filter '@ai-token-report/server' build:node
node $SSH --out packages/server/dist/main.mjs $DST/main.mjs
for f in fixture.sh run.sh bench.mjs parity.mjs report.mjs; do
  node $SSH --out packages/server/verify/perf/runtime-ab/$f $DST/$f
done

node $SSH $DST/fixture.sh setup     # 克隆生产库 + 造夹具凭证（只建 atr_http_v5_* 库）
node $SSH $DST/run.sh               # node → bun → node → bun，然后对账 + 汇总
node $SSH --get /tmp/atr-ab-results/REPORT.md .artifacts/runtime-ab-REPORT.md
node $SSH $DST/fixture.sh dispose   # ★ 一定要清理
```

细节（安全闸门、端口断言、踩过的坑）见
[`packages/server/verify/perf/runtime-ab/README.md`](../packages/server/verify/perf/runtime-ab/README.md)。
