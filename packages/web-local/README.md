# 本地用量页面（`packages/web-local`）

我自己的 token 用量页 —— **只看本机**，数据来自本地服务的 `/api/local/*`。

由 `dsh-token --web`（或 `bun run web`）启动：CLI 内嵌一个只监听
`127.0.0.1` 的服务，页面由它托管。数据来自**本地 SQLite 增量库**
（`$DSH_HOME/token-report/usage.sqlite`，由会话日志增量派生），
**不上报、不出网、断网可用**。首次启动需全量建库（约 15 秒），之后每次请求约 50ms。

> 📖 数据通路与职责划分见根目录 [`ARCHITECTURE.md`](../../ARCHITECTURE.md) §3.1 与 §6。

## 快速开始

```bash
bun run build:local    # 构建产物（--web 依赖它）
bun run web            # 起服务并自动开浏览器
bun run dev:local      # 或：Vite 开发服务器（需另起本地服务提供 /api/local/*）
```

### 开发模式要同时起两个进程

`bun run dev:local` 起的**只是 Vite（前端资源）**，它不实现 `/api/local/*`。
必须另起一个提供接口的后端，否则页面会显示
「服务端返回了非 JSON 响应（HTTP 200）」：

```bash
bun run web -- --no-open    # 后端，默认 127.0.0.1:8787
bun run dev:local           # 前端，5199，把 /api 转发到 8787
```

两个都要开：**只开 `dev:local` 就会看到那个报错**。
`vite.config.ts` 已配好 `/api` → `http://127.0.0.1:8787` 的转发
（与 `--web` 内嵌服务的页面行为一致）。后端端口被 CLI 自动 +1 时
（8787 被占用会顺延），用环境变量指向实际地址：

```bash
DSH_LOCAL_API=http://127.0.0.1:8788 bun run dev:local
```

> 日常只看数据用 `bun run web` 即可 —— 一个进程，页面由后端直接托管，
> 不存在转发问题。`dev:local` 只在改前端代码、需要热更新时用。

## 页面结构

| 区块 | 组件 | 说明 |
|---|---|---|
| 署名提示条 | `App.vue` | 未署名时明确告知「不会采集也不会上报」 |
| 筛选工具栏 | `UsageFilterBar` | 时间维度、刷新、清除筛选条件、导出 CSV |
| 指标卡片组 | `UsageMetricGrid` → `UsageMetricCard` | 计费总量 / 缓存命中率 / 调用次数 / 会话数 |
| 趋势图表 | `MetricGroupSection` → `MetricChartPanel` → `MetricChartCard` | 计费总量（柱状）+ 调用次数（面积） |
| 分组明细 | `UsageDetailTable` | 按厂商模型 / 厂商 / 模型 / 项目 切换分组 |

### 两种图表形态

`MetricChartCard` 是唯一的图表渲染组件，用原生 SVG 按 `kind` 切换，**不依赖任何图表库**：

| kind | 用于 | 画法 |
|---|---|---|
| `bar` | 计费总量 | 单色柱状 |
| `area` | 调用次数 | Catmull-Rom 转三次贝塞尔的平滑面积图 |

> **坐标系说明**：SVG 的 `viewBox` 宽度是固定的**逻辑宽度 480**，配合
> `preserveAspectRatio="none"` 由 CSS 横向拉伸铺满卡片，因此任意卡片宽度下
> 柱与间隙的比例都一致，首屏几何直接就是正确的。
>
> ⚠️ **Y 轴刻度自下而上**（`['0', '50%', '100%']`），而屏幕坐标自上而下增大。
> 刻度位置是 `plotHeight * (n - 1 - i) / (n - 1)`。写成 `* i / ...` 会得到
> 一个上下颠倒的 Y 轴 —— 代码照样跑，但图与刻度互相矛盾。

## 目录结构

```
src/
├── api/
│   ├── request.ts   # fetch 包装，失败返回 ApiResult 而非抛错
│   ├── identity.ts  # 署名读写
│   └── stats.ts     # /api/local/stats/*
├── components/
│   ├── ui/          # 通用基础组件
│   ├── identity/    # 署名引导页
│   └── usage/       # 业务组件
├── composables/
│   ├── usage-view-model.ts  # 契约响应 → 视图模型（唯一的格式化/相加处）
│   ├── useUsageStats.ts     # 数据编排（并发拉取三接口）
│   └── useIdentity.ts       # 署名状态编排
├── types/usage.ts   # 领域类型（对齐 shared 契约）
├── utils/format.ts  # 数值格式化
├── views/UsageStatsView.vue
├── styles/base.css
├── App.vue
└── main.ts
verify/              # 断言脚本，不参与构建
```

## 数据口径

★ **口径不在前端计算。** `cacheHitRate` / `cacheLeverage` 等指标一律由服务端
按 `packages/shared/src/metrics.ts` 算好返回，前端只做格式化
（`0.9503` → `'95.0%'`）。前端一旦自己算一遍，就是第二个口径来源。

四项 token 始终**分列展示**，展示时才相加：

```
计费总量 = 未缓存输入 + 输出 + 缓存读 + 缓存写
```

`input`（未缓存输入）**不是**总输入 —— 实测 `cacheRead` 占总用量约 **94.3%**，
把它并进 input 或干脆不显示，这张表就彻底失真了。

**不展示金额**：无单价来源，只展示 token 数（已确认决策）。

## 验证

```bash
bun run verify             # 数据层 + 组件渲染（SSR，无需浏览器与服务）
bun run verify:layout      # 无头 Chrome 量取真实布局（需先起服务）
```

- `verify-data.ts` —— 喂样本数据给视图模型，断言格式化正确、
  且**输出里不含任何金额字段**（`CNY` / `¥` / `cost`）。
- `verify-render.ts` —— 走 Vite SSR 真实渲染组件树。
  ⚠️ SSR 没有本地服务，`fetch` 必然失败，因此断言的是**外壳与「无金额」**，
  数值断言在 `verify-data.ts`。
- `verify-layout.ts` —— 走 Chrome `--dump-dom` 读渲染后的 SVG 属性，
  覆盖纯 SSR 断不到的部分。

## 设计说明

- **设计令牌**集中在 `styles/base.css` 的 CSS 变量中。
- **图表**用原生 SVG，避免为两张图引入 ECharts 级别的依赖。
- **请求失败不抛异常**，统一返回 `ApiResult` —— 页面据此显示
  「无法连接本地服务」而不是白屏；用户此时最需要知道发生了什么。
- **并发拉取**：overview / series / breakdown 三个请求同时发出，
  服务端把它们合并到同一次日志扫描（见 `server/src/local-api.ts`）。
  串行发只会白等两轮。
- **时间窗不在前端换算**：`timeRange` 直接就是服务端认识的具名周期
  （`today` / `week` / …），时区口径只在 `core/range.ts` 定义一处。