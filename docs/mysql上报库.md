# 部门上报库接入 MySQL

> 本文是 `packages/core/src/db` 里 MySQL 支持的设计与实测记录。
> 面向**改这块代码的人**与**部署这套服务的人**。
> 方案背景见 `docs/server架构重构方案.md`；口径规则见 `AGENTS.md` 三条铁律。

---

## 0. 落地状态（全部已落地并验收通过）

| 部分 | 状态 | 证据 |
|---|---|---|
| 方言层 `dialect.ts` | ✅ | `bun run --filter '@ai-token-report/core' verify:mysql` → **17 项全过**（活体，真实 MySQL） |
| 驱动层 `mysql.ts`（`Bun.sql` + 共享池 + `$name`→`?`） | ✅ | 同上（含「同名参数出现多次」「缺参数抛错」） |
| 上报库门面 `portal-db.ts`（异步 + MySQL DDL + 版本闸门） | ✅ | 同上（upsert 语义、幂等 `changes` 判据、`AS new` 别名） |
| 查询构建器（`query.ts`，两种后端共用一份 SQL）+ `portal.ts` 异步会话 + `num()` 归一 | ✅ | `packages/server/verify/verify-mysql-portal.ts` → **53 项全过** |
| 服务端接线（`--mysql` / `ATR_MYSQL_URL` / 横幅脱敏 / 上报与看板同一目标） | ✅ | 同上脚本走**生产入口** `createServer()`；横幅断言「不含密码」 |
| 双后端逐位对账 | ✅ | 同一批数据下 `overview` / `series(day,hour)` / `breakdown(user,provider,model,provider-model,project,day,hour)` / `records` 的**整个响应体 JSON 全等** |
| 单测（方言 + 位置参数翻译） | ✅ | `packages/core/test/dialect.test.ts`（16 项，纯单元，进 `bun test`） |
| SQLite 退路 | ✅ | 三个 e2e（35/54/27）与契约测试全部走 SQLite 默认路径，全绿 |

**验收命令与真实数字**：

```
bun test                                                  617 pass / 0 fail / 28 files   (exit 0)
bun run packages/server/verify/verify-mysql-portal.ts     53 项通过                     (exit 0)
bun run --filter '@ai-token-report/core' verify:mysql      17 项通过                     (exit 0)
bun run packages/server/test/e2e-{ingest,admin,identity}.ts  35 / 54 / 27 项通过          (exit 0)
bun run build:npm:cli && bun run verify:npm:cli            双运行时全绿；发布产物仍零运行时依赖
```

> ⚠️ 在 pwsh 里 `bun ... 2>&1 | Select-Object -First N` 有**两个**坑：
> ① 它会把 bun 的 stderr 当错误记录，从而虚报 `exit 1`（真实退出码要单独取）；
> ② `-First N` 会**提前掐断管道并杀掉 bun**，留下半清理状态 —— 紧接着的第二次运行
> 会因此看到脏数据。看长输出用 `-Last N`，或先重定向到文件。

---

## 1. 边界：谁可以接 MySQL，谁绝对不行

| | 本机库 `usage.sqlite` | 部门上报库 |
|---|---|---|
| 谁在用 | 员工机器上的 `dsh-token --web` | 集中部署的部门服务端 |
| 能不能有外部依赖 | 🚨 **不能** —— 单机自足、断网可用是这套 CLI 的前提 | 能（它本来就跑在服务器上） |
| 后端 | **恒为 SQLite** | 默认 SQLite，配了 `ATR_MYSQL_URL` 就切 MySQL |

**这条边界不是靠自觉，是靠类型**：本地路径的 `ingest()` / `readWatermarks()` /
`insertRecords()` / `openDatabaseForIngest()` 收的是**同步 SQLite `Database`**，
而 MySQL 侧只有异步的 `PortalStore` —— 本地路径**够不到** MySQL。
`docs/server架构重构方案.md` §5 的迁移红线在这里同样成立。

### Node 上暂不支持 MySQL（刻意的）

Node 没有内建 MySQL 客户端，要靠 `mysql2`（7 个传递依赖）。而：

- 部门服务端的部署形态本来就是 **Bun**；
- npm 发布出去的那份 CLI 只跑本机库（SQLite），**永远用不到 MySQL**。

为一条用不到的通路引依赖、并把它塞进发布产物，是净负担。所以 Node 上配了 MySQL 会
**明确报错并给出路**（用 Bun 跑服务端，或改用 `--db` 走 SQLite 退路），
而不是静默降级成 SQLite 让人以为连上了。

---

## 2. 六条实测结论（都是「猜错就静默出错」的那类）

> 全部在本机 Docker 的 MySQL 8.4.9 上实测，脚本见「附录：怎么自己复核」。

### 2.1 🚨 `SUM(BIGINT)` 返回的是**字符串**

```
SELECT COUNT(*) AS calls, SUM(input_tokens) AS input ...
→ {"calls":3,"input":"60"}          // calls 是 number，input 是 string
```

MySQL 的 `SUM()` 结果是 DECIMAL，驱动按精度优先给字符串。若把 `"60"` 当 token 数用，
`shared/metrics.ts` 的除法会得到 `NaN`，或加法变成字符串拼接 —— **页面上的数字悄悄变成错的**。
⇒ 归一化放在**唯一的口径边界**（`portal.ts` 行映射里的 `num()`），而不是散在各查询点。

⚠️ 空结果集的 `SUM()` 是 `null`（不是 0）—— 所以 `num()` 必须同时处理 `null`。

### 2.2 🚨🚨 `||` 在 MySQL 里是**逻辑或**，不是字符串拼接

`query.ts` 的 `provider-model` 维度原来写的是 `provider || '/' || model`：

| 后端 | 结果 |
|---|---|
| SQLite | `"dashscope/qwen-max"` ✅ |
| MySQL | `provider OR '/' OR model` → **`0` 或 `1`** ❌ |

分组键会静默变成 `"0"`/`"1"`：看板上的「模型分布」变成两行，而**没有任何报错**。
⇒ 走 `dialect.concat()`（MySQL → `CONCAT(a, b, c)`）。这是本次迁移最危险的一处。

### 2.3 🚨 `key` 是 MySQL 保留字

`SELECT ... AS key` 在 MySQL 直接**语法错误**（SQLite 允许）。
⇒ 分组别名统一用 `grp_key`，在 TS 侧再映射回字段 `key`（**对外类型与线上契约不变**）。

### 2.4 `MAX(a, b)` → `GREATEST(a, b)`

SQLite 的 `MAX(a, b)` 是标量函数；MySQL 的标量最大值叫 `GREATEST`。
MySQL 也有 `MAX()`，但那是**聚合函数**，用在 `SET` 里会报错。
⇒ `dialect.scalarMax()`。

### 2.5 幂等与 upsert 的语法差异（会报错，好抓）

| | SQLite | MySQL |
|---|---|---|
| 幂等插入 | `INSERT OR IGNORE INTO` | `INSERT IGNORE INTO` |
| 冲突更新 | `ON CONFLICT(k) DO UPDATE SET x = excluded.x` | `... VALUES (...) AS new ON DUPLICATE KEY UPDATE x = new.x` |

✅ `INSERT IGNORE` 撞主键时 `affectedRows = 0` —— 与 SQLite 的 `changes` **语义一致**，
所以「`changes > 0` 即新插入」这条去重判据**不需要改**（实测确认）。
✅ 「归属以先到为准」在 MySQL 上同样成立（后到者整行不写，不会覆盖归属）。
✅ `AS new` 别名在 8.4 可用（`VALUES()` 形式在 8.4 已废弃）。

### 2.6 连接与 sql_mode

- 必须带 **`allowPublicKeyRetrieval: true`**：MySQL 8.4 默认认证插件是
  `caching_sha2_password`，非 TLS 连接下驱动要取服务端公钥，否则报
  `The server requested RSA public key retrieval ... over an insecure connection`。
- 默认 `sql_mode` 含 **`ONLY_FULL_GROUP_BY`**：分组查询的 SELECT 列表只能出现
  聚合函数与 GROUP BY 表达式本身。现有 SQL 天然满足（分组表达式与 GROUP BY 一致），
  但**新增分组查询时要注意**。
- **时间一律存 `BIGINT`（epoch 毫秒），绝不用 `DATETIME`**：
  那会把时区语义引进来，而本仓已经在「SQLite 按 OS 时区、JS 按进程 TZ」上吃过一次亏
  （见 `query.ts` 的 `dimensionExpression` 注释）。
- **`realpath`/软链无关**，但表结构上：索引列用 `VARCHAR(255)`（utf8mb4 下 1020 字节，
  远小于 InnoDB 3072 字节的索引上限），`cwd` 用 `TEXT`（不索引、不分组）。

---

## 3. 架构：一份 SQL，两种后端

```
packages/core/src/db/
  dialect.ts      ★ 四处语法差异的**唯一**落点（含 concat/scalarMax/upsert 模板）
  mysql.ts        异步 MySQL 后端：Bun.sql + 进程内共享池 + $name→? 翻译
  portal-db.ts    ★ 上报库门面：openPortalStore(target) → PortalStore（异步，两种后端共用）
                  + MySQL DDL + 「schema 不符抛错绝不重建」闸门
  query.ts        ★ SQL 构建器（两种后端共用同一份文本）+ 同步执行器（本地路径）
  portal.ts       部门看板会话（异步，用构建器 + 方言）
  ingest.ts       本地路径（**同步 SQLite**）；portal 写入（异步 + 方言）
```

设计要点：

1. **SQL 文本只有一份**。`query.ts` 的构建器产出 `$name` 参数，MySQL 侧由
   `toPositional()` 翻译成 `?` 位置参数。因此不存在「MySQL 版查询与 SQLite 版查询
   各自演化」的可能。
   ⚠️ `toPositional` 查表用的是**带 `$` 的原始键**（`params['$since']`）——
   本仓 `buildWhere()` 产出的键就带前缀。写错会让**每句 SQL 都抛「参数缺失」**。
2. **异步只在 portal 一侧**。MySQL 驱动只有异步 API，所以上报库门面统一成异步；
   本机库路径**保持同步**（`bun run stats` 的终端表格就是产品本身，不要为它引入
   Promise 洪水与随之而来的时序问题）。
3. **`close()` 的语义按后端不同**：SQLite 真的关；MySQL **空操作**（连接来自进程内
   共享池，每请求关池会让下一个请求重新 TCP + 认证握手）。上层照常
   `finally { await store.close() }`，两种后端形状一致。
4. **MySQL 侧只建 portal 真正用到的两张表**（`usage_event` + `ingest_run` + 版本表
   `portal_meta`）：`file_watermark` / `session_state` 是**本机增量扫描**的水位线，
   部门服务端从不扫日志，建了永远是空表。

---

## 4. 部署

### 4.1 本机开发（当前这台机器）

本机开发用的实例是 Docker 容器 **`local-database-review-mysql`**（`mysql:8.4`，
宿主端口 **3335**）。账号来自开发机的 `.env`，**库名是本项目自己的**：

```
端口  3335
账号  mysql_user / mysql_password        # 来自开发机 .env
库名  ai-token                           # ★ 本项目专用（不是 .env 里的 local-mysql）
```

于是本地连接串是：

```bash
ATR_MYSQL_URL='mysql://mysql_user:mysql_password@127.0.0.1:3335/ai-token'
```

⚠️ 这台实例是**多个项目共用**的（里面还有 `g92-mysql` / `presales-kb` /
`stec-promis-jyzg` / `suit-mysql` / `test` / `local-mysql`）。本项目**只碰 `ai-token`**，
在里面建三张表：`usage_event` / `ingest_run` / `portal_meta`。
两个验收脚本的默认连接串就是这个（可用 `ATR_MYSQL_URL` 覆盖）。

> 💡 容器卷已存在时，MySQL 官方镜像的初始化脚本**不会重跑** —— 所以
> 即使 env 里有 `MYSQL_DATABASE`，库也可能并不存在（授权倒是早就给了）。
> 补建一次并把授权给它即可：
>
> ```sql
> CREATE DATABASE IF NOT EXISTS `ai-token`
>   CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
> GRANT ALL PRIVILEGES ON `ai-token`.* TO 'mysql_user'@'%';
> FLUSH PRIVILEGES;
> ```

### 4.2 生产部署（新实例或已有实例上建库）

在**现有** MySQL 实例上建库建号；🚨 **不要动同一个实例里别人的库**：

```sql
CREATE DATABASE IF NOT EXISTS ai_token_report
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS 'atr_user'@'%' IDENTIFIED BY '<换成强密码>';
GRANT ALL PRIVILEGES ON ai_token_report.* TO 'atr_user'@'%';
FLUSH PRIVILEGES;
```

### 4.3 起服务

```bash
# 用 MySQL（部门服务端）
ATR_MYSQL_URL='mysql://atr_user:<密码>@127.0.0.1:3306/ai_token_report' \
  bun run --filter '@ai-token-report/server' start --host 127.0.0.1 --port 8787

# 等价写法（命令行旗标）
bun run --filter '@ai-token-report/server' start --mysql 'mysql://…' --port 8787

# 或继续用 SQLite（默认；也是 Node 上的唯一选择）
bun run --filter '@ai-token-report/server' start --db /var/lib/atr/portal.sqlite
```

⚠️ **同时给了 `--mysql` 与 `--db` 不会报错**：`openPortalStore()` 的语义是
「有 `mysqlUrl` 就用它」，`dbPath` 退化成不被使用的退路（一个部署里只该有一种真值，
但这里选择「明确优先」而不是「拒绝启动」—— 拒绝会让「多加了一个旗标导致服务起不来」
这种低价值故障发生）。
✅ 启动横幅会打印**实际生效**的那一个，并且**已脱敏**（见 §3 的 `describePortalTarget()`）。

### 4.3 备份（比 SQLite 时代更需要）

`portal.sqlite` 时代备份是「拷一个文件」。MySQL 之后：

- 上报库仍是**全员数据的唯一副本**（客户端投递成功后已清掉自己的 pending/outbox），
  所以 **`mysqldump` 要进定时任务**，并且要**演练恢复**；
- 表结构版本不符时程序**抛错拒绝工作**（绝不自动重建、绝不 drop），
  换 schema 前必须先备份 + 导出；
- 表里**没有 `total_tokens` 列**（铁律 2），别指望从库里直接 sum 出总量当口径 ——
  总量由 `shared/metrics.ts` 算。

---

## 5. 附录：怎么自己复核这些结论

```bash
# ★ 方言层的活体验证（17 项）：INSERT IGNORE 前缀 / CONCAT 拼接 / SUM 字符串 /
#   upsert 语义（GREATEST + AS new + COALESCE）。自带 probe_* 探测表的创建与清理，
#   不碰 usage_event 等业务表。默认连本机开发实例，可用 ATR_MYSQL_URL 覆盖。
bun run --filter '@ai-token-report/core' verify:mysql

# ★★ 双后端逐位对账（53 项，最强的那个）：同一批上报数据起两个服务端
#    （SQLite / MySQL），断言看板每个接口**整个响应体 JSON 全等**，
#    并额外断言两侧数字都等于脚本手算值（防「两边都空所以相等」）。
#    它还覆盖生产入口（`createServer` + 横幅脱敏）与清理（只删自己造的行、绝不 DROP 表）。
#    默认同样连本机开发实例，可用 ATR_MYSQL_URL 覆盖。
bun run packages/server/verify/verify-mysql-portal.ts
```

> 这个脚本抓到过一个真 bug：`toPositional()` 曾用**剥掉 `$` 的名字**去查参数表，
> 而 `buildWhere()` 产出的键是带 `$` 的 —— 结果是每句真实 SQL 都抛「参数缺失」。
> 单测若只喂自造的参数对象很容易把它当约定漏掉；这里直接喂 `buildWhere()` 的真实产出。

复核时要盯住的三条「静默失败」信号：

| 信号 | 说明 |
|---|---|
| 分组键出现 `"0"` / `"1"` | `\|\|` 被当成逻辑或了（§2.2） |
| 看板数字是 `NaN` 或形如 `"6060"` | `SUM()` 的字符串没归一（§2.1） |
| 「模型分布」只有两行、且名字是 0/1 | 同 §2.2 |