# 部门上报库接入 MySQL

> 本文是 `packages/core/src/db` 里 MySQL 支持的设计与实测记录。
> 面向**改这块代码的人**与**部署这套服务的人**。
> 方案背景见 `docs/server架构重构方案.md`；口径规则见 `AGENTS.md` 三条铁律。

---

## 0. 原 MySQL 接入阶段的历史验收快照

本节 707 项等数字记录旧阶段，不能替代当前 Portal v4 验收。当前身份和用量已共用数据库，显式迁移、约束目录核验及独立进程 HTTP 结果见 [v4 验证记录](database-v4/验证记录.md)；正式命令见 [数据库部署与迁移](数据库部署与迁移.md)。

| 部分 | 状态 | 证据 |
|---|---|---|
| 方言层 `dialect.ts` | ✅ | `bun run --filter '@ai-token-report/core' verify:mysql` → **17 项全过**（活体，真实 MySQL） |
| 驱动层 `mysql.ts`（`Bun.sql` + 共享池 + `$name`→`?`） | ✅ | 同上（含「同名参数出现多次」「缺参数抛错」） |
| 驱动层 `mysql.ts`（**Node 侧可选 `mysql2`**） | ✅ | `bun run --filter '@ai-token-report/server' verify:mysql:node` → **49 项 + 编排 6 项全过**（真 Node + 真 mysql2）；含两驱动 `changes` 对照表（§2.7） |
| 上报库门面 `portal-db.ts`（异步 + MySQL DDL + 版本闸门） | ✅ | 同上（upsert 语义、幂等 `changes` 判据、`AS new` 别名） |
| 查询构建器（`query.ts`，两种后端共用一份 SQL）+ `portal.ts` 异步会话 + `num()` 归一 | ✅ | `packages/server/verify/verify-mysql-portal.ts` → **53 项全过** |
| 服务端接线（`--mysql` / `ATR_MYSQL_URL` / 横幅脱敏 / 上报与看板同一目标） | ✅ | 同上脚本走**生产入口** `createServer()`；横幅断言「不含密码」 |
| 双后端逐位对账 | ✅ | 同一批数据下 `overview` / `series(day,hour)` / `breakdown(user,provider,model,provider-model,project,day,hour)` / `records` 的**整个响应体 JSON 全等** |
| 单测（方言 + 位置参数翻译） | ✅ | `packages/core/test/dialect.test.ts`（16 项，纯单元，进 `bun test`） |
| SQLite 退路 | ✅ | 三个 e2e（35/54/29）与契约测试全部走 SQLite 默认路径，全绿 |

**验收命令与真实数字**：

```
bun test                                                     707 pass / 0 fail / 32 files  (exit 0)
bun run typecheck                                            7 个包全部                   (exit 0)
bun run packages/server/verify/verify-mysql-portal.ts        53 项通过                    (exit 0)
bun run --filter '@ai-token-report/core' verify:mysql        17 项通过                    (exit 0)
bun run --filter '@ai-token-report/server' verify:mysql:node 49 项 + 编排 6 项通过（真 Node）(exit 0)
bun run packages/server/test/e2e-{ingest,admin,identity}.ts  35 / 54 / 29 项通过          (exit 0)
bun run build:npm:cli && bun run verify:npm:cli              双运行时全绿；发布产物仍零运行时依赖
```

> ⚠️ 上面这些**条数**（`bun test` 的文件数、e2e 的项数）会随仓里新增测试而变化 ——
> 口径是「**0 fail**」，不是「恰好 N 项」。看到数字变大不要当成回归。

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

### Node 上走**可选依赖 `mysql2`**（Bun 上走内建 `Bun.sql`）

| 运行时 | 驱动 | 说明 |
|---|---|---|
| **Bun** | 内建 `Bun.sql` | 本地 SQLite 部署可使用 Bun；MySQL 长密码兼容限制见下文 |
| **Node** | **`mysql2`**（3.24.4，正式服务端依赖） | 正式 MySQL 部署推荐使用 Node/mysql2；core 仍在运行时动态加载，CLI/插件不内联 |

### 已知兼容限制：Bun 1.4.2 与长 MySQL 密码

2026-09-26 在 MySQL 8.4.9、默认 `caching_sha2_password`、仅获隔离库权限的新账号上实测：16、19 字符密码通过；20、32、64、128 字符密码在 Bun 1.4.2 原生驱动均返回认证错误 1045。URL、配置对象、显式 password 覆盖、password 回调四种传参结果一致，共 24 个新账号首次认证组合。真正 Node v22.21.1/mysql2 使用相同 64 位随机十六进制强密码首次登录成功；先让 Node 登录也不能修复 Bun 登录。

这与 [Bun 官方 issue #26195](https://github.com/oven-sh/bun/issues/26195) 报告的超过 19 字符密码认证问题一致。需要长密码的部署使用真正的 Node + mysql2，保留强密码和既有认证插件；不要缩短密码或切换旧认证策略绕过问题。

本仓仅在 Bun **实际返回 1045 且所提供密码长度超过 19** 时补充中文排障提示，保留原始错误为 `cause`；不会预先拒绝长密码、切换驱动或打印连接串/密码。若后续 Bun 版本修复，应重新执行新账号首次认证测试后更新本限制。脱敏矩阵和清理证据见 [database-v4/mysql-auth-diagnosis.json](database-v4/mysql-auth-diagnosis.json)。

没装 mysql2 时**明确报错并给出确切的安装命令**，绝不静默降级成 SQLite
（降级会让人以为「连上了」，实际数据写进了另一条通路）：

```bash
cd packages/server && bun add mysql2
```

⚠️ **两边都不进 npm 发布产物**：`packages/cli` 的产物会把 core 整个内联进 `cli.js`，
而 mysql2 走的是**动态 import + 构建期不可静态分析的说明符**
（源码 `const specifier = 'mysql2/promise'; await import(specifier)`，
产物里保留的也是 `await import(specifier)`，**没有被折叠成字面量**）——
打包器没法把它折叠成常量，于是既不会内联、也不会写进发布清单。
实测证据（`packages/cli/dist/cli.js`，2026-09-25）：

| 检查 | 结果 |
|---|---|
| `from 'mysql2'` / `require('mysql2')` 形式的**静态引入** | **0** |
| mysql2 的传递依赖名（`sqlstring` / `denque` / `iconv-lite` / `named-placeholders` / `seq-queue` / `generate-function` / `aws-ssl-profiles` / `lru-cache`） | 各 **0** |
| 产物清单里的 `dependencies` 字段 | **整段不存在**（`verify:npm:cli` 断言的就是「零运行时依赖」） |
| 裸搜子串 `mysql2`（`Select-String -SimpleMatch`） | **18 处命中 —— 全是我们自己的字符串与标识符**：函数名 `loadMysql2` / `mysql2Channel` / `wrapMysql2` / `mysql2PoolBackend`、`const specifier = "mysql2/promise"`、`driver: "mysql2"`，以及那条「怎么装 mysql2」的错误文案。⚠️ 那个说明符**必须**留在产物里，否则运行期动态 import 无从取值 ⇒ 这条子串搜索**不能**当作「产物里有 mysql2 依赖」的判据，判据是上面三行。 |

⚠️ **解析位置**：本仓 `bun install` 是**隔离式布局**（每个包各有一份 `node_modules`，
`mysql2` 只在 `packages/server/node_modules` 里，根 `node_modules` **没有**它）。
而裸说明符是按**导入它的那个文件**所在目录逐级向上找的 —— 所以 Node 侧要在
**部门服务端自己的入口/产物**（`packages/server/...`）里跑，否则会报「解析不到 mysql2」。
活体验证脚本自己处理了这件事（在临时目录里给 `mysql2` 做一个 junction），见 §5。

---

## 2. 八条实测结论（都是「猜错就静默出错」的那类）

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

### 2.7 ⚠️ `changes`：两个驱动**只有一半**一致

`changes` 是本仓**唯一被消费**的驱动语义（`ingest.ts` 的「`changes > 0` 即新插入」去重判据）。
`verify:mysql:node` 用**逐字相同**的语句在两个驱动上各量一遍并并排打印，实测：

| 语句 | `Bun.sql` | `mysql2` | |
|---|---|---|---|
| `INSERT IGNORE` 新插入 / 撞主键 | 1 / **0** | 1 / **0** | ★ 本仓消费这一行，两边一致 |
| `INSERT` | 1 | 1 | |
| `ON DUPLICATE KEY UPDATE`：真的改了值 | 2 | 2 | |
| `ON DUPLICATE KEY UPDATE`：**匹配上但值没变** | **0** | **1** | ⚠️ 不一致 |
| `UPDATE`：匹配上但值没变 | **0** | **1** | ⚠️ 不一致 |

差在最后两行：mysql2 默认带 **`CLIENT_FOUND_ROWS`**（`connection_config.js` 的
`getDefaultFlags` 里就有它），于是它返回的是**匹配行数**而不是改动行数。
本仓不消费这类语句的返回值（`recordIngestMoment()` 直接丢掉结果），所以差异目前是**潜在**的 ——
但**将来谁要拿 `changes` 判「有没有真的写进去」，必须先在两个驱动上分别实测**。

### 2.8 Node 侧（mysql2）另外三条与 Bun 不同的地方

| 关注点 | `Bun.sql` | `mysql2` |
|---|---|---|
| `allowPublicKeyRetrieval` | **必需**（8.4 的 `caching_sha2_password`） | **不认**：传了会打 `Ignoring invalid configuration option` 告警，而它并不需要（实测直连成功） |
| 多语句（`exec()` 拿到的整段 DDL） | `unsafe()` 直接跑 | 必须 `query()`（文本协议）+ **`multipleStatements: true`**；`execute()` 一律拒绝多语句 |
| 默认字符集 | utf8mb4 | utf8mb4（实测，4 字节字符往返无损 ⇒ 不必显式传 charset） |

---

## 3. 架构：一份 SQL，两种后端

```
packages/core/src/db/
  dialect.ts      ★ 四处语法差异的**唯一**落点（含 concat/scalarMax/upsert 模板）
  mysql.ts        异步 MySQL 后端：Bun.sql（内建）/ mysql2（Node 可选依赖）
                  + 进程内共享池 + $name→? 翻译；事务用**同一条连接**
  portal-db.ts    ★ 上报库门面：openPortalStore(target) → PortalStore（异步，两种后端共用）
                  + 「schema 不符抛错绝不重建」闸门
  portal-schema-v4.ts  内嵌受控 DDL，与 docs SQL 逐字对照，产物无需 docs 目录
  portal-migrations.ts 显式 inspect/migrate/resume、备份、检查点及实际约束校验
  portal-connection.ts 固定连接事务、SQLite FULL 与异步写锁排队
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
4. **MySQL Portal v4 使用 17 张身份/事实表、`ingest_run` 和 `portal_meta`**。
   `file_watermark` / `session_state` 是**本机增量扫描**的水位线，
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

⚠️ 这台实例由多个项目共用。上面的 `ai-token` 是既有业务库，不能拿它做 v4 破坏、建删表或迁移演练。
当前方言与 v4 验证脚本创建并清理自己随机命名的隔离 schema；MySQL 应用 QA 使用仅授权专用隔离库的账号。
验证结果不表示既有业务库已经升级。正式部署和备份迁移步骤以 [数据库部署与迁移](数据库部署与迁移.md) 为准。

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

# 或继续用 SQLite（默认；没装 mysql2 或不想依赖数据库服务时的退路）
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

# ★★ Node 侧活体验证（49 项 + 编排 6 项）：bun build --target=node 打成临时 .mjs
#    （放 %TEMP%，脚本自己清理），再用**真 Node** 运行。断言 Node + mysql2 + 我们的
#    驱动/门面这条通路：INSERT IGNORE 的 0/1 判据、SUM(BIGINT) 的字符串、CONCAT 拼接键、
#    upsert 的 GREATEST/COALESCE、事务回滚、嵌套事务不隐式提交、utf8mb4 往返；
#    并并排打印两个驱动的 `changes` 对照（§2.7）。
#    ⚠️ 脚本自己找真 node：`bun run <package.json 脚本>` 时 PATH 上会多出一个
#    **Bun 的副本冒充 node**（`%TEMP%\bun-node-<hash>\node.exe`），用它跑等于没验 Node。
#    可用 ATR_NODE_BIN 指定 node 可执行文件。
bun run --filter '@ai-token-report/server' verify:mysql:node
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
