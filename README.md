# AI Token Report

DSH token 用量统计平台。四种形态：**命令行 / 本地页面 / 部门看板 / DSH 插件**。

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
bun run server

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
> 在页面上填入管理员发放的身份 token 即可看到本部门的人员排行、
> 部门趋势、模型分布、用量明细与采集覆盖率诊断。
> 筛选栏支持**时间窗**（今天 / 上周 / 本月 / 最近 90 天…或自定义起止时间）、
> **人员多选**与厂商 / 模型。
>
> **人员管理**：管理员登录后右上多一个「人员管理」页签 ——
> 在页面上**发放 / 重置 / 吊销** token（姓名、部门、角色），
> 不必再手工改凭证文件。

## 目录

| 路径 | 职责 |
|---|---|
| `packages/shared` | **契约单一真源**：上报 DTO、查询响应、口径公式 |
| `packages/core` | **统计内核**：解码 / 扫描 / 聚合 / 时间范围 / 水位线 / 身份存储 |
| `packages/cli` | 命令行入口：`stats` / `report` / `--web` |
| `packages/server` | 后端：上报接收 + 本地直查 + 部门统计 + **人员管理（凭证读写）** + 静态托管 |
| `packages/web-local` | **本地页面**：只看本机，数据来自 `/api/local/*` |
| `packages/web-portal` | **部门看板 + 人员管理页**：看全员，数据来自 `/api/v1/stats/*` 与 `/api/v1/admin/members*`（需身份 token） |
| `packages/dsh-plugin` | **DSH 插件**：实时上报 |

## 三条铁律

1. **口径只在 `shared/src/metrics.ts` 定义。** 任何地方要算缓存命中率等指标，
   必须调用它，不要各自重写 —— 两端口径不一致的 bug 极难排查。
2. **`cacheRead` 不是 input 的一部分。** `input` 是「未命中缓存」那部分，
   实测 `cacheRead` 占总用量 **94.3%**，漏掉它等于漏掉 94% 的用量。
3. **上报只需 at-least-once。** 幂等键 `event_id = sessionId:seq` 由服务端
   `ON CONFLICT DO NOTHING` 去重，所以插件与 CLI 可以同时上报而无需协调。

## 身份署名

**首次打开页面会要求填写姓名与 token**（管理员发放）。在此之前：

- ❌ 不采集、也不向任何服务端发送数据
- ✅ 仍可查看本机统计（那是你自己的数据）

填写后保存在 `$DSH_HOME/token-report/identity.json`，**本地页与插件共用同一份**，
填一次即可。`token` 是**身份凭证** —— 姓名以服务端凭证表为准，改本地文件无法冒用他人身份。

### 管理员准备凭证

在服务端的 `<dshHome>/token-report/credentials.json` 里登记**第一个管理员**：

```jsonc
[ { "token": "atr-boss-9f3c", "name": "李经理", "role": "admin" },
  { "token": "atr-zhangsan-9f3c", "name": "张三", "dept": "研发一部" } ]
```

也可以完全不碰文件，用环境变量起服务（该 token 不会写进文件）：

```bash
ATR_ADMIN_TOKEN=atr-boss-9f3c ATR_ADMIN_NAME=李经理 bun run server
```

之后**都在页面上发放**：管理员登录 →「人员管理」→ 填姓名 / 部门 / 角色 →
「生成并发放 token」，把新 token 复制给本人（本地页与插件填的是同一个）。
同一个页面还能**重置 token**（旧 token 立即失效）与**吊销**（本人此后无法上报与看看板）。

两条与权限有关的约定：

- **角色只有两个**：`member`（缺省，可看全部门看板）与 `admin`（额外可进人员管理页）。
  **不要用姓名白名单判断管理员** —— 姓名是可以随便改的显示值。
- **最后一个管理员不可删除、不可降级**：否则没人能再发放 token，只能改文件恢复。
  凭证文件**读不懂时服务端拒绝一切写入**（不拿空表覆盖唯一真值），
  此时管理页会显示「不可写」与原因。

## 环境要求

- Bun ≥ 1.1
- Node ≥ 22（`zlib.zstdDecompressSync` 需要）

## 开发

```bash
bun test                    # 全仓测试
bun run --filter '*' typecheck
bun run build               # 构建两个 web 应用
```