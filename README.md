# AI Token Report

DSH token 用量统计平台。四种形态：**命令行 / 本地页面 / 部门看板 / DSH 插件**。

> 📖 **先读 [`ARCHITECTURE.md`](./ARCHITECTURE.md)** —— 整体结构与职责划分。
> 口径细节见 [`TOKEN-STATS-DESIGN.md`](./TOKEN-STATS-DESIGN.md)，
> 插件方案见 [`PLAN.md`](./PLAN.md)。

---

## 快速开始

```bash
bun install          # 安装全部工作区依赖

# ① 终端里看统计（读本机日志，不联网）—— ✅ 已可用
bun run stats -- --period today

# ② 本地页面：内嵌服务 + 自动开浏览器 —— ✅ 已可用
bun run build:local   # 首次需先构建前端产物
bun run web

# ③ 独立部署部门服务端 —— ✅ 已可用
bun run server
```

> **实现进度**：`stats`（终端统计）、`web`（本地页面）与 `server` 已可用。
> 以下尚未实现：
>
> - `bun run report`（增量上报，待 S3 上报接口）
> - `packages/web-portal` 部门看板页面（待 S8；当前是骨架占位）
>
> 详见 [`ARCHITECTURE.md`](./ARCHITECTURE.md) §8 阶段表。

## 目录

| 路径 | 职责 |
|---|---|
| `packages/shared` | **契约单一真源**：上报 DTO、查询响应、口径公式 |
| `packages/core` | **统计内核**：解码 / 扫描 / 聚合 / 时间范围 / 水位线 / 身份存储 |
| `packages/cli` | 命令行入口：`stats` / `report` / `--web` |
| `packages/server` | 后端：上报接收 + 本地直查 + 部门统计 + 静态托管 |
| `packages/web-local` | **本地页面**：只看本机，数据来自 `/api/local/*` |
| `packages/web-portal` | **部门看板**：看全员，数据来自 `/api/v1/stats/*` |
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

在服务端的 `<dshHome>/token-report/credentials.json` 里登记：

```json
[ { "token": "atr-zhangsan-9f3c", "name": "张三", "dept": "研发一部" } ]
```

然后把 token 发给对应员工。

## 环境要求

- Bun ≥ 1.1
- Node ≥ 22（`zlib.zstdDecompressSync` 需要）

## 开发

```bash
bun test                    # 全仓测试
bun run --filter '*' typecheck
bun run build               # 构建两个 web 应用
```