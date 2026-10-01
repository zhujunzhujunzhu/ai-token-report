# 运行时 A/B：Node 22 与 Bun 的**同机同库**对照

回答一个问题：**把部门服务端从 Node 22 换成 Bun，性能到底差多少。**
结论与完整数字见 [`docs/性能：Node22 与 Bun 对比实测.md`](../../../../../docs/性能：Node22%20与%20Bun%20对比实测.md)。

本目录是那篇报告的**可复现夹具**。它与 `verify/perf/` 下其余脚本的区别：

| | `verify/perf/*.ts`（已有） | 本目录 |
|---|---|---|
| 测什么 | 单个后端（MySQL / SQLite）在**不同数据规模与 buffer pool** 下的表现 | **同一个产物、同一个库**，只换运行时 |
| 跑在哪 | 开发机（Docker MySQL） | **被测服务器本机** |
| 数据 | 合成夹具（`seed.ts` 造数） | **生产库整份克隆** |

---

## 一、为什么必须这么做（三条方法论）

1. 🚨 **客户端一定要跑在被测机本机。**
   从开发机打过去，SSH 往返会把「两个运行时的差异」淹没在「本机到 `117.72.173.21` 的 RTT」里。

2. ★ **必须交替轮次：node → bun → node → bun。**
   只跑一轮的话，第一轮撞上冷页缓存，会被读成运行时的差异。
   `report.mjs` 会先打印**同运行时两轮之间的差异**——那就是噪声底噪，跨运行时的差异小于它的一律不可信。

3. ★ **主指标是「服务端进程 CPU 时间 / 请求」，不是 p50。**
   `/proc/<pid>/stat` 的 `utime+stime` 不受客户端调度、网络与 MySQL 排队影响；
   而这里的墙钟延迟有 80% 以上花在等 MySQL 上，p50 会把运行时的差异盖住。
   脚本两个都量，报告以 CPU 为主、p50 为辅。

---

## 二、文件

| 文件 | 跑在哪 | 作用 |
|---|---|---|
| `ssh-exec.mjs` | 开发机 | 本地 → 目标机的通用远程执行与双向传文件（送脚本、传产物、取报告） |
| `fixture.sh` | 目标机 | `setup` 克隆生产库 + 造夹具凭证；`reset` 清压测写入；`dispose` 全删 |
| `run.sh` | 目标机 | 编排：交替起停两个实例、逐轮跑 `bench.mjs`、最后 `parity.mjs` 对账、汇总 |
| `bench.mjs` | 目标机 | 压测客户端：逐端点 p50/p95、并发看板加载、上报吞吐、CPU/请求、RSS |
| `parity.mjs` | 目标机 | 双实例**逐字节**比对全部 stats 响应 + 上报 ACK/判重语义 |
| `report.mjs` | 目标机 | 把逐轮 JSON 汇总成一张对照表，写 `<dir>/REPORT.md` |

---

## 三、怎么跑

```bash
# 0. 本机构建**同一份**产物（两个运行时共用，避免「比的其实是两份代码」）
bun run --filter '@ai-token-report/server' build:node

SSH=packages/server/verify/perf/runtime-ab/ssh-exec.mjs
DST=/data/ai-token-report/packages/server/runtime-ab

# 1. 送上去。⚠️ 产物必须放服务端包目录**之内**：
#    `mysql2/promise` 是按「导入它的那个文件所在目录」逐级向上解析的，
#    放到 /tmp 下 Node 会解析不到它，表现为启动即报「缺少 mysql2」。
node $SSH --out packages/server/dist/main.mjs $DST/main.mjs
for f in fixture.sh run.sh bench.mjs parity.mjs report.mjs; do
  node $SSH --out packages/server/verify/perf/runtime-ab/$f $DST/$f
done

# 2. 建隔离夹具（克隆生产库 + 一把已知明文的管理凭证 + 一个隔离 MySQL 用户）
node $SSH $DST/fixture.sh setup

# 3. 跑矩阵（约 20 分钟：4 轮 × ~2 分钟 + 对账 + 汇总）
node $SSH $DST/run.sh

# 4. 取回报告
node $SSH --get /tmp/atr-ab-results/REPORT.md .artifacts/runtime-ab-REPORT.md

# 5. ★ 一定要清理（否则克隆库、隔离用户、测试凭证会留在服务器上）
node $SSH $DST/fixture.sh dispose
```

想调强度：`ATR_AB_REPEATS=10`；只跑部分轮次：`run.sh node:1 bun:1`；
只做对账：`run.sh --parity`；改测别的产物：`ATR_AB_ART=/path/to/other/main.mjs`。

---

## 四、安全边界（写死在脚本里）

| 闸门 | 位置 | 作用 |
|---|---|---|
| 隔离库名必须以 `atr_http_v5_` 开头 | `fixture.sh` | `DROP DATABASE` 写错一个名字 = 全员历史用量永久消失 |
| 源库名不得含 `bench` / `test` | `fixture.sh` | 防止把夹具当生产库克隆 |
| 克隆用 `--single-transaction` | `fixture.sh` | 不锁生产表 |
| 隔离用户只授克隆库 | `fixture.sh` | 不碰 `ai_token_report` 的权限 |
| 杀进程一律按 PID | `fixture.sh` / `run.sh` | `pkill -f` 会匹配到远端脚本自身（见 `ssh-exec.mjs` 文件头第 3 条） |
| 起服务前断言端口空闲、起完断言监听者就是本次 pid | `run.sh` | `--port` 被占会**静默 +1**，于是测的是上一个残留实例，而输出一切正常 |

---

## 五、两个必须知道的运行时差异（否则结论是假的）

1. 🚨 **Bun 连线上 MySQL 需要 TLS —— 这件事已经修进代码，夹具不必再手工加参数。**
   线上 `atr_user` 口令 32 字符，Bun 1.4.2 在**非 TLS** 连接下对
   `caching_sha2_password` + 口令 ≥ 20 字节会直接 `errno 1045` 认证失败
   （[oven-sh/bun#26195](https://github.com/oven-sh/bun/issues/26195)，
   与口令强度无关，**不要为此缩短口令**）。
   `openMysqlBackend()` 现在会按需自动启用 TLS（`planBunMysqlAuth()`），
   `run.sh` 里 Bun 侧的 `?tls=true` 只是**显式复现线上形态**的冗余保险 ——
   去掉它也应该能跑通。代价实测约 +3% CPU。
   > 夹具用户的 32 字符口令是**故意**的：它复现线上的这个边界。
   > 单独复验这条路径：`bun run --filter '@ai-token-report/server' verify:mysql:bun-auth`。

2. ⚠️ **两个运行时用的不是同一个 MySQL 驱动。**
   Bun → 内建 `Bun.sql`；Node → 可选依赖 `mysql2`（`packages/core/src/db/mysql.ts`）。
   所以「逐位对账」（`parity.mjs`）不是可选项：它证明换驱动没有改变任何数字。

---

## 六、已知未覆盖

- **只在单机单实例上量**。`pm2` 的 cluster 模式、多实例共享 MySQL 的争用没有覆盖。
- **静态资源走的是 `node:fs/promises` 这条路**（本仓硬约束：服务端不得依赖 `Bun.file()`），
  所以这一项量的是「Bun 实现 Node fs API 的性能」，不是 Bun 原生静态托管的性能。
- **压测期间生产服务仍在同一台机器上跑**（2 vCPU），对两个运行时是同等的背景噪声，
  没有做 CPU 隔离到「完全干净」的程度。
