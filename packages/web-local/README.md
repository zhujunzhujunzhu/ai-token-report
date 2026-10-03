# 本地用量页面（`packages/web-local`）

我自己的 token 用量页 —— **只看本机**，数据来自本地服务的 `/api/local/*`。

由 `ai-token --web`（或 `bun run web`）启动：CLI 内嵌一个只监听
`127.0.0.1` 的服务，页面由它托管。数据来自**本地 SQLite 增量库**
（`~/.ai-token-report/usage.sqlite`，由会话日志增量派生），
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
| 配置弹框 | `UiModal` → `IdentityGate` | ★ **只有两栏：部门服务端地址 + appKey**（与 DSH 插件的「连接配置」同一形态）。未配置身份时自动弹出，可关掉（统计页照常可看，只是不采集不上报）；点右上角「配置」随时重开 |
| 筛选工具栏 | `UsageFilterBar` | 时间维度、刷新、清除筛选条件、导出 CSV |
| 指标卡片组 | `UsageMetricGrid` → `UsageMetricCard` | 计费总量 / 缓存命中率 / 调用次数 / 会话数 |
| 趋势图表 | `MetricGroupSection` → `MetricChartPanel` → `MetricChartCard` | 计费总量（柱状）+ 调用次数（面积） |
| 分组明细 | `UsageDetailTable` | 按厂商模型 / 厂商 / 模型 / 项目 切换分组。★ 切换维度时**只重取明细表**，旧行留在原地（淡化 + 表头「更新中…」）—— 不闪回骨架、不塌成一行占位 |

### 配置为什么只有两栏

员工手上真正拿到的只有**部门服务端地址**和**一串 appKey**。
姓名与分组由服务端按 appKey 解析（见 `.agents/skills/identity-attribution/SKILL.md`），
所以界面上没有这两栏 —— 填了也不作数。提交时本地服务拿 appKey 向该地址的
`POST /api/v1/identity/verify` 校验，**通过才落盘**：

```
<dataDir>/identity.json            # 「我是谁」（服务端认定的姓名 + 分组 + 凭证）
<dataDir>/plugin-connection.json   # 「连哪台 + 拿什么凭证」（与 DSH 插件共用同一份）
```

地址优先级：**页面里存过的那份 > 启动参数 `--portal`**。
连接配置是**合并写**：本地页只动 `baseUrl` / `appKey` 两个键，
插件的上报间隔 / 面板位置 / 会话日志根一个字节都不碰。

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
│   ├── ui/          # 通用基础组件（含 UiModal 弹框外壳）
│   ├── identity/    # 「配置」弹框（服务端地址 + appKey）
│   └── usage/       # 业务组件
├── composables/
│   ├── usage-view-model.ts  # 契约响应 → 视图模型（唯一的格式化/相加处）
│   ├── useUsageStats.ts     # 数据编排（首屏/换时间窗取三接口；换分组维度只取明细）
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

**金额（估算）自 v7 起会展示**（旧的「不展示金额」决策已作废）：

- 概览多一张「费用（估算）」卡片、明细表多一列费用、页面上一行**费用口径**说明。
- ★ **前提是这台机器配置过上报**（「配置」弹框里填过服务端地址 + appKey 并校验通过，
  即 `<dataDir>/identity.json` 已署名）：**没配置时整块费用都不出现** ——
  没有卡片、没有费用列、没有口径那一行、CSV 里也没有那两列。
  理由：那种机器上页面能用的价只有**内置种子价**（只覆盖 `deepseek-official`
  那几个模型），在以 Claude Code / Codex / Trae 为主的机器上它既不是这些模型的价、
  也不是这个部门谈的价，却会以一个「看起来正常」的金额出现在第一屏。
  开关在服务端（`server/src/local-api.ts` 的 `#reportingConfigured()`），
  **未配置时连单价文件都不读、连记录都不物化**；页面侧一个字节都没改 ——
  它本来就按「字段在不在」决定出不出现。判据是**活取值**：
  在页面里配完，下一次刷新（3 秒轮询内）金额就会出现，不必重启本地服务。
- 金额全部由服务端算好（`packages/shared/src/price.ts` 的
  `cost = input×p_in + output×p_out + cacheRead×p_cr + cacheWrite×p_cw`，
  四类**分开乘**，按币种分别累加、**绝不换算也绝不相加**，多币种用 ` + ` 连接）。
  前端只做格式化（`14200` 微元 → `¥0.01`），**绝不出现 `amountMicro / 1e6`**。
- 价来自数据目录下的 **`pricing.json` 快照**（`ai-token-report pricing sync` 写入），
  没有就退回**内置种子价**并在响应里如实标注来源。本地页与部门看板读的不是同一份价，
  所以「按哪份单价算的」这一行必须与金额同时在场。
- 🚨 **未计价的用量绝不显示成 `¥0.00`**，而是写「未计价」，并在口径那一行给出比例。
  把没配上价的用量算成 0，会让「漏配价」看起来像「省了钱」。
- 页面按「字段在不在」决定出不出现：服务端没下发 `cost`（未配置上报，或旧版本）时，
  一位金额都不显示 —— 这正是不许用 `¥0.00` 顶替的原因。

## 验证

```bash
bun run verify             # 数据层 + 组件渲染（SSR）+ 取数编排（假 fetch，无需浏览器与服务）
bun run verify:layout      # 无头 Chrome 量取真实布局（需先起服务）
```

- `verify-data.ts` —— 喂样本数据给视图模型，断言格式化正确、
  **金额三态**（无 `cost` 字段 → 一位金额都不显示 / 未计价 → 「未计价」而不是 ¥0 /
  有金额 → 多币种用 ` + ` 连接）。
- `verify-render.ts` —— 走 Vite SSR 真实渲染组件树。
  ⚠️ SSR 没有本地服务，`fetch` 必然失败，因此外壳部分断言的是**停在 loading 壳时一位金额都不显示**
  （连「费用（估算）」也不该出现）；另有**明细表模板层**的断言
  （费用列表头 / 金额 / 「未计价」/ 没下发 `cost` 时整列不出现 /
  ★ 有行时即便在取数也**不塌成占位行**、首屏才用占位行）——
  模板里的列集合是动态的，只跑视图模型断言看不出「逻辑对了但模板还引用旧列」。
  ★ 另有**配置弹框**的断言（`role="dialog"` / 有「服务端地址」与「appKey」两栏 /
  **没有**姓名与分组输入框 / 已署名时把服务端认定值显示成只读文案）：
  SSR 停在 loading 壳时整棵 App 树渲染不到弹框，所以那里是**单独渲染**
  `IdentityGate` 来钉这一版最关键的产品决策。
- `verify-loading.ts` —— 把真实的 `useUsageStats()` 跑起来（Vite SSR 加载，走 `@/` 别名），
  用假的 `fetch` 数请求、控时序。★ 守的是**「点一下分组维度页签，整页不许闪一下」**：
  只发 breakdown 一个请求、`summary`（卡片 / 图表）的对象引用一个都没换、
  任何一轮都不闪回首屏骨架、在飞时筛选又变了则旧结果丢掉（否则会先画一遍旧维度再换 = 闪两下）。
  这类回归**不报错**，只让页面抖一下 —— 类型检查、SSR、数据层断言全都看不出来。
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
- ★ **换分组维度不重取三个接口**：服务端的筛选条件只有
  `period` / `provider` / `model`，`by` 只进 breakdown 一个接口。
  早期实现把三者绑在一起重取，于是点一下维度页签会多跑两趟无关请求，
  并把卡片与图表整体重建、让卡片闪回骨架、明细表塌成一行占位（整页一收一放）。
  现在换维度只发 breakdown：卡片与图表**一个字节都不动**，
  明细行在原地换掉（淡化 + 表头「更新中…」）。
  与之配套的状态只有两个：`loading`（首屏，还没有任何数据 → 骨架 / 占位）
  与 `busy`（用户发起的一轮在飞 → 淡化 + 文案；后台每 3 秒轮询刻意不置它）。
- **时间窗不在前端换算**：`timeRange` 直接就是服务端认识的具名周期
  （`today` / `week` / …），时区口径只在 `core/range.ts` 定义一处。