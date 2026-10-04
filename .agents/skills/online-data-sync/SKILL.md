---
name: online-data-sync
description: 把线上部门库（117.72.173.21 的 MySQL 8）的数据搬到本机 SQLite 上报库，用真实数据调试 / 复盘。Use when the local portal.sqlite needs production rows, when you must clone or partially mirror the online schema, or when a schema version bump blocks local startup; not for writing configuration rows to production (that is online-model-pricing / online-project-rules) and not for the local CLI's own usage.sqlite log index.
version: 1.0.0
---

# 线上数据同步到本地库

管的是「把线上那份**真实数据**拉到本机 SQLite 上报库」，让本地看板/接口能在真数据上跑。
**不管**往线上写东西（那是 `online-model-pricing` / `online-project-rules`），也不碰 CLI 的 `usage.sqlite`。

---

## 0. 三条先弄清楚，否则白跑

### 0.1 查规模只能用 `COUNT(*)`，别信 `information_schema.tables.table_rows`

🚨 对 InnoDB 它只是**近似值**。实测（2026-10-04）：它报 `usage_event = 55,507`，
真实 `COUNT(*)` 是 **196,246** —— 差 3.5 倍。按近似值估传输量与耗时一定会翻车。

### 0.2 先确认两侧 schema 版本差的是不是「纯权限版本」

版本差不一定意味着表结构不同。例如 **v13 不含任何 DDL**（只往 `role_permissions`
插一行权限），所以 v12 与 v13 的**表结构逐字一致**，行可以按原列直接搬。
判断方法：读 `packages/core/src/db/portal-schema-vN.ts` 的文件头注释。

本地库版本不对时先迁：
```bash
bun run packages/server/scripts/migrate-db.ts inspect --db <portal.sqlite>
bun run packages/server/scripts/migrate-db.ts migrate --db <portal.sqlite> --confirm-offline
```
迁移前**手工 cp 一份**库（脚本自带 VACUUM INTO 备份，但多一份更安心）。

### 0.3 🚨 只搬事实表，服务端会拒绝启动

`ensurePortalReady()` 在 SQLite 上跑 `PRAGMA foreign_key_check`，而
`usage_event` 对 **`members` 与 `report_tokens`** 有外键（还是复合的：
`(member_id, report_token_id) → report_tokens(member_id, token_id)`）。
缺了它们，启动直接报「检测到外键不一致」。

→ 主数据**必须一起搬**，但用 `INSERT OR IGNORE` **合并**、**不删**本地已有的 admin 行、
**不碰 `login_accounts`**，本地登录账号就不受影响（实测 members 1 → 10，admin 照旧能登）。

---

## 1. 搬运四步

### ① 远端导出（口令不出目标机）

远端 `/usr/local/bin/bun` 直连 `127.0.0.1:3308`：

```js
const db = new Bun.SQL({ url: 'mysql://atr_user:' + encodeURIComponent(apw) + '@127.0.0.1:3308/ai_token_report', tls: true })
```

🚨 **`tls: true` 是必需的**：MySQL 8 要求 RSA 公钥检索，Bun 拒绝在不安全连接上做，
不带 tls 必报 `server requested RSA public key retrieval… over an insecure connection`。
口令从 `/root/.atr/mysql8-credentials.txt` 读（`[atr_user]` 段）。

输出 NDJSON，两个必踩的坑：

- **BigInt**：`JSON.stringify` 遇到 `bigint` 直接抛错 → 必须给 replacer
  `(k, v) => (typeof v === 'bigint' ? Number(v) : v)`（本仓毫秒时间戳与 token 数都远在安全整数内）。
- **大表分页用键集，不用 OFFSET**：`WHERE event_id > ? ORDER BY event_id LIMIT 5000`。
  OFFSET 翻到 19 万行会越来越慢。

### ② 回传

`gzip` → `base64` → 经 `runRemote()` 的 stdout 回传（`maxBuffer` 256MB 够）。
19.6 万行 = 120MB NDJSON → 5.9MB gz，一次连接几秒。

⚠️ **bun 是 Windows 原生，脚本内部不能写 `/tmp/xxx`**：Git Bash 的路径映射只在
**命令行参数**上生效，`writeFileSync('/tmp/…')` 会 ENOENT。落项目内 `.artifacts/<日期>/`。

### ③ 本地写入

`bun:sqlite` 用**参数绑定** `INSERT` —— 这样就绕开了 mysqldump 文本那套方言坑
（`\'` / `\N` / 二进制字面量在 SQLite 里全都不是一回事）。每 2 万行 COMMIT 一次。

写入前先取本地表的列名（`pragma_table_info`），**逐行校验**线上行没有本地表不存在的列 ——
这是结构一致性的最后一道证明。

### ④ 对账（不能省）

线上是**活的**，所以必须**冻结窗口**再比：用导出文件的 mtime 作
`received_at_ms <= T`，两侧再各算一次 `COUNT(*)` 与四类 token 的 `SUM`，要求**逐位一致**。

---

## 2. 本机服务端的登录账号（验证同步结果要用）

- 账号：`admin`，口令在 `~/.ai-token-report/server.env` 的 `ATR_ADMIN_PASSWORD`
  （首次启动自动生成，只在空库初始化一次）。
- 登录是「用户名 + 口令 + 4 位图形验证码」。自动化验证三件事：
  1. `GET /api/v1/auth/captcha` 的响应是**扁平**的 `{captcha_id, image, expires_in}`，**没有 `data` 包裹**；
  2. 验证码可反解：`HMAC-SHA256(key, captcha_id + ':' + answer)` 对 `0000~9999` 穷举，
     与库里 `auth_challenges.answer_hmac` 比对（key 就是 server.env 里的 `ATR_CAPTCHA_HMAC_KEY`）；
  3. 🚨 `POST /api/v1/auth/login` **必须带 `x-portal-request: 1`**，否则 403「请从本站页面提交操作」。

---

## 3. 已知副作用

写入时若执行过 `PRAGMA journal_mode=WAL`，它会**持久生效**在该库上（无害，但要知道自己改过）。
线上 `/tmp` 的导出文件用完要删（含真实业务数据）。
