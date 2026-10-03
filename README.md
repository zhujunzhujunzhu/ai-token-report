# AI Token Report

AI token 用量统计平台。四种形态：**命令行 / 本地页面 / 部门看板 / DSH 插件**。

> 📖 **先读 [`ARCHITECTURE.md`](./ARCHITECTURE.md)** —— 整体结构与职责划分。
> 口径细节见 [`docs/口径实测结论.md`](./docs/口径实测结论.md)，
> 插件方案见 [`docs/插件方案.md`](./docs/插件方案.md)。

---

## 快速开始

```bash
bun install          # 安装全部工作区依赖

# ① 终端里看统计（读本机日志，不联网）—— ✅ 已可用
bun run stats -- --period today

# ② 本地页面：内嵌服务 + 自动开浏览器 —— ✅ 已可用
bun run build:local   # 首次需先构建前端产物
bun run web

# ③ 独立部署部门服务端（含部门看板页面）—— ✅ 已可用
bun run build:portal  # 首次需先构建看板前端产物
bun run server       # 先按下文配置数据库及首次管理员账号

# ④ 增量上报到部门服务端（由计划任务每 10 分钟调用）—— ✅ 已可用
bun run report -- --endpoint http://<服务端>:8787/api/v1/token-usage --token <管理员发的 token>
```

> **实现进度**：`stats`（终端统计）、`web`（本地页面）、`server`（上报接收 +
> **部门看板**）与 `report`（CLI 上报）均已可用。
> 四种形态（CLI / 本地页面 / 部门看板 / DSH 插件）全部落地，
> 详见 [`ARCHITECTURE.md`](./ARCHITECTURE.md) §8 阶段表。
>
> **部门看板**：`bun run server` 起服务后打开 `http://<服务端>:8787/`
> （页面由服务端静态托管，构建产物在 `packages/web-portal/dist`），
> 使用账号密码和验证码登录，即可看到本部门的人员排行、
> 部门趋势、模型分布、用量明细与采集覆盖率诊断。
> 筛选栏支持**时间窗**（今天 / 上周 / 本月 / 最近 90 天…或自定义起止时间）、
> **人员多选**、**分组多选**与厂商 / 模型。
>
> **人员管理**：管理员登录后右上多一个「人员管理」页签 ——
> 在页面上维护人员、**分组（可多选）**、角色、登录账号及上报 Token，
> 数据统一保存在部门数据库。分组本身在「分组管理」页维护（`/groups`）。

## 目录

| 路径 | 职责 |
|---|---|
| `packages/shared` | **契约单一真源**：上报 DTO、查询响应、口径公式 |
| `packages/core` | **统计内核**：解码 / 扫描 / 聚合 / 时间范围 / 水位线 / 身份存储 |
| `packages/cli` | 命令行入口：`stats` / `report` / `--web` |
| `packages/server` | 后端：上报接收 + 本地直查 + 部门统计（含分组目录与分组维度查询）+ **数据库身份、人员与分组管理** + 静态托管 |
| `packages/web-local` | **本地页面**：只看本机，数据来自 `/api/local/*` |
| `packages/web-portal` | **部门看板 + 人员管理页 + 分组管理页**：看全员，数据来自 `/api/v1/stats/*`（含分组候选项 `/api/v1/stats/groups` 与人员候选项 `/api/v1/stats/members`）、`/api/v1/admin/members*` 与 `/api/v1/admin/groups*`（数据库会话鉴权） |
| `packages/dsh-plugin` | **DSH 插件**：实时上报 + 界面用量面板（安装含 **DSH Desktop 桌面端**，见 [`docs/桌面端安装交付清单.md`](./docs/桌面端安装交付清单.md)） |

## DSH 插件安装

```bash
# 命令行版 DSH：一条命令，`add` 会自动登记到 profile 的 dsh.profile.bundles
dsh plugin --profile web add dsh-plugin-token-report@latest
```

**DSH Desktop（桌面端）的图形入口装不了本插件** —— 侧边栏「插件」市场只接受
[awesome-dsh-plugin](https://awesome-dsh-plugin.com) 精选列表内的来源，本插件不在其中。
走命令行，把 home / pnpm 换成 Desktop 自己那一套即可：

```powershell
$env:DSH_HOME = "$env:APPDATA\dsh-desktop\harness"
$env:PATH     = "$env:DSH_HOME\.desktop-bin;$env:PATH"   # ★ 用 Desktop 自己的 pnpm / node
node "<安装目录>\resources\app.asar.unpacked\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  plugin --profile web add dsh-plugin-token-report@latest
```

逐条步骤、核对命令、日志取证与回滚见 [`docs/桌面端安装交付清单.md`](./docs/桌面端安装交付清单.md)，
插件自身的配置与排障见 [`packages/dsh-plugin/README.md`](./packages/dsh-plugin/README.md)。

> 🚨 三件事必须同时成立，否则症状是「面板不见了、而且一条也不上报」，**不是报错**：
> ① 官方 OTel 后端已 `disabled: true`（同一时刻只能有一个 `sessionTelemetry`）；
> ② 装的是**发布包 / 构建产物**，不是仓内源码包（它的 `main` 指向 `src/index.ts`，Node 加载即失败）；
> ③ 宿主的 `@deepseek-ai/dsh*` 落在插件的 peer 兼容窗口 `>=0.1.7-rc.2 <0.3.0-0` 内。

## 三条铁律

1. **口径只在 `shared/src/metrics.ts` 定义。** 任何地方要算缓存命中率等指标，
   必须调用它，不要各自重写 —— 两端口径不一致的 bug 极难排查。
2. **`cacheRead` 不是 input 的一部分。** `input` 是「未命中缓存」那部分，
   实测 `cacheRead` 占总用量 **94.3%**，漏掉它等于漏掉 94% 的用量。
3. **上报只需 at-least-once。** 幂等键 `event_id = sessionId:seq` 由服务端
   `ON CONFLICT DO NOTHING` 去重，所以插件与 CLI 可以同时上报而无需协调。

## 身份署名

**首次使用本地页面或插件时只要求填两样：部门服务端地址 + appKey**（管理员发放）。
姓名与分组**不由用户填** —— 它们由服务端按 appKey 解析（填了也不作数）。在此之前：

- ❌ 不采集、也不向任何服务端发送数据
- ✅ 仍可查看本机统计（那是你自己的数据）

填写后保存在**数据目录**下：`identity.json`（谁）+ `plugin-connection.json`（连哪台、拿什么凭证），
缺省 `~/.ai-token-report/`，可用配置项 `dataDir` 或 `DSH_TOKEN_REPORT_DATA_DIR` 覆盖；
**本地页与插件的「配置」是同一形态、写同一份配置**，在哪里填一次都生效。
`appKey` 是**身份凭证** —— 姓名以服务端凭证表为准，改本地文件无法冒用他人身份。
DSH Desktop 与命令行版 DSH **缺省就共用这份署名**（数据目录不再跟随各自的 home），
想各用一套时才在插件配置里指 `dataDir`（**不要**改 `dshHome`），见 `packages/dsh-plugin/README.md` §1.1。

### 数据库与管理员初始化

正式部署采用 **MySQL**，本地运行和测试保留 **SQLite**。人员、分组、角色权限、
账号、Token、会话、验证码、限流和审计均落数据库；正常请求不再读取凭证文件。

空库首次启动时，通过部署秘密配置注入 `ATR_ADMIN_USERNAME`、`ATR_ADMIN_PASSWORD`
及至少 32 个字符的 `ATR_CAPTCHA_HMAC_KEY`；MySQL 再配置 `ATR_MYSQL_URL`。
管理员配置只初始化一次，后续以数据库为准。MySQL 正式部署建议使用已验证的
Node/mysql2 入口，完整命令见 [数据库部署与迁移](./docs/数据库部署与迁移.md)。

**本机自用不必手配这些**：`bun run server` 在「本机 SQLite 上报库 + 监听 `127.0.0.1`」
时，会把缺失的验证码密钥与**随机生成**的管理员口令写进数据目录下的 `server.env`
（缺省 `~/.ai-token-report/server.env`），下次启动直接复用 —— 配了 `--mysql` /
`ATR_MYSQL_URL`（共享库）或 `--host` 非回环地址时**不**自动生成，仍按上面显式配置。

管理员登录后创建人员，分配**分组（一个人可同属多个分组）**和角色，再按需要开通登录或签发上报 Token。
默认 Token 只有署名与上报权限，明文只显示一次。轮换、撤销和停用立即生效。
人员用稳定 ID 标识，可以同名；姓名不能作为权限或归属的依据。

最后一个有效管理员入口不可被删除、停用或降级。旧 v3 / v4 数据库和 `credentials.json`
必须按文档显式迁移（v3 → v4 冻结基线 → v5）并保留备份，服务不会自动重建唯一的历史数据。

## 环境要求

- Bun ≥ 1.1
- Node ≥ 22（`zlib.zstdDecompressSync` 需要）

## 开发

```bash
bun test                    # 全仓测试
bun run --filter '*' typecheck
bun run build               # 构建两个 web 应用
```
