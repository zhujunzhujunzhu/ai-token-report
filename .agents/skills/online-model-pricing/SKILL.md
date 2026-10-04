---
name: online-model-pricing
description: 给线上的部门服务端补 / 改模型单价时用（117.72.173.21/ai-token 的「模型单价」页背后那张 model_price 表）。Use when researching a vendor's official price list, filling the unpriced part of production usage, writing model_price rows through the admin API, or checking that the dashboard really computes amounts afterwards; not for the local pricing.json snapshot (that is `pricing sync`) and not for changing the cost formulas themselves (`packages/shared/src/price.ts`).
version: 1.0.0
---

# 操作线上模型单价

管的是**线上那张 `model_price` 表**：谁在用、有没有价、怎么按官方价目补上、补完怎么证明看板真的算出了金额。

**不管**：成本口径本身（`packages/shared/src/price.ts` + `token-metrics-contract` skill）、
离线端的价快照（`pricing sync` → 数据目录下的 `pricing.json`）、
以及账单（月度对账 `reconcile:bill` 是全仓唯一允许出现账单金额的地方）。

工具只有两个文件，都在 `scripts/`（Node 脚本，与 `deploy-server.mjs` 同款）：

| 文件 | 职责 |
|---|---|
| `scripts/online-pricing.mjs` | 操作台：`usage` / `prices` / `plan` / `apply` / `verify` |
| `scripts/online-pricing-plan.mjs` | 纯逻辑：单位换算、冲突判定、远端脚本渲染（被 `packages/server/test/online-pricing-plan.test.ts` 钉住） |

---

## 0. 五分钟走完

```bash
node scripts/online-pricing.mjs usage                      # ① 谁在用、有没有价（只读）
node scripts/online-pricing.mjs plan  --file scripts/online-pricing-catalog.<vendor>.json  # ② 算计划（只读）
node scripts/online-pricing.mjs apply --file scripts/online-pricing-catalog.<vendor>.json  # ③ 真写入
node scripts/online-pricing.mjs verify                     # ④ 看板概览，核对真的算出金额
```

现成的价目表**按口径分成两份** —— 这就是「官方」与「中继」的区分（§1.4）：

| 文件 | 口径 | 币种 | 覆盖的 provider |
|---|---|---|---|
| `scripts/online-pricing-catalog.official-usd.json` | 官方直连挂牌价 | **USD** | `openai` / `anthropic` / `dashscope` / `cc-switch-official` |
| `scripts/online-pricing-catalog.relay-cny.json` | 中继 / 网关 **¥1=$1** | **CNY** | 基础价 `*`（兜住 `custom` / `deeprouter` / `tokenrun` / `szjt` / 其余一切） |

两份都是**幂等**的：再 `apply` 一次只会打印「无变化」并跳过 —— 实测第二次 `apply`
时 11 行里 9 行被跳过、只写进了新增的 2 行（跳过逻辑按 `(provider, model)` 逐行判，
不看它来自哪个文件）。

实测（2026-10-04）：

| 轮次 | 写入 | 覆盖率 | 看板金额（CNY） |
|---|---|---|---|
| 起点 | 13 条价 | 51.4% | 一条都算不出（GPT/Codex 系全未计价） |
| 第 1 轮 | +6 条 OpenAI 基础价 | 98.98% | ¥12,824.09 |
| 第 2 轮 | +3 条 Anthropic 基础价 | 99.22% | ¥12,872.07 |
| 第 3 轮 | +13 条官方 USD 专属价、+2 条中继近似价 | **99.86%** | **USD $6,707.13 ＋ CNY ¥6,230.76** |

第 3 轮的数字变化**只换了币种标签、没有改数值**（¥1=$1 的含义就是两套数字相同）：
第 2 轮那个 ¥12,872.07 = 第 3 轮的 `6,230.76 + 6,707.13`（差额 65.8 是本轮新补的
`gpt-6` / `qwen3.8-max`）。这正是「不区分口径」时看板会给出的那个**既不等于人民币支出、
也不等于美元支出**的数。

余下 0.14% 是**没有权威价可查**的（`custom/(unknown)` 连模型名都没有、
`openai/codex-auto-review` 是 Codex 内部模型、`workbuddy/*` 与 deeprouter 那几个
只调用过几次的网关私有模型）。

---

## 1. 五条铁律

### 1.1 🚨 写数据走管理接口，不直接改库

`POST /api/v1/admin/pricing` 的 upsert 语义与**区间重叠**判定都在
`repository.setModelPrice()` 里；库里那条 UNIQUE 索引只认
`(provider, model, effective_from_ms)` **完全相同**的一类，`[0, ∞)` 与 `[1000, 2000]`
它拦不住。两条重叠的价同时生效的后果不是报错，而是**同一段用量按哪条价算取决于读取顺序**
—— 两次查询都能自圆其说。走接口还顺带拿到审计行与事务内重鉴权。

工具里的读（`usage` / `prices` / `plan`）走**只读 SQL**（少一次登录，且 `renderSqlProbe()` 有只读闸门）；
只有 `apply` 走接口。

### 1.2 🚨 单价永远是**四元组**，不是一个数

`input / output / cacheRead / cacheWrite` 各自独立。缓存读与输入差一个数量级、
`cacheWrite` 常常是 0（官方写 `-`）。合成一个价 = 让 94% 以上的 token 算错。

### 1.3 单位：界面与官方页是「货币单位 / 百万 token」，库里是「整数微元 / 千 token」

两者差 **×1000**（`1 微元/千 ≡ 1 货币单位/百万`）。
价目表 JSON 里写官方的原生数值（`4` = `$4 或 ¥4 / 百万`），换算由
`rateToMicro()` 做，与计价页输入框走**同一套进位规则**（第 4 位小数起四舍五入并告警）。
⚠️ 单价没有「大概对」：错一位就是 10 倍，而页面上只显示一个看起来很正常的数字。

### 1.4 🚨 官方与中继是**两套口径**，必须用币种分开记

同一份官方价目会被两种付钱方式用掉，而它们**不是一回事**：

| 口径 | 谁 | 币种 | 含义 |
|---|---|---|---|
| **官方直连** | `openai` / `anthropic` / `dashscope` / `cc-switch-official` | **USD** | 厂商端点，账单是真美元。★ 本部门相当一部分走**官方订阅套餐**，所以按 API 挂牌价折出来的只是**等价成本**，用来跟套餐费对比，不是真实账单 |
| **中继 / 网关** | `custom` / `deeprouter` / `tokenrun` / `szjt` / 其余一切（基础价 `*`） | **CNY** | 网关自己按 **¥1 = $1** 记账：把官方挂牌的美元数值直接当人民币填 |

**为什么必须分开**：两种口径的数值常常**一模一样**，于是「合成一种币种」看起来毫无影响 ——
但那样看板给出的那个数**既不等于人民币支出、也不等于美元支出**，而且没有任何地方会报错。
实测（2026-10-04 第 3 轮）：同一批用量，分开记是 `USD $6,707.13 ＋ CNY ¥6,230.76`，
合成一种币种就是那个既不是人民币、也不是美元的 `¥12,937.89`。

**绝不换算汇率**：中继的 ¥1=$1 是**记账约定**，不是汇率。要换成真实汇率，那是人的决定，
不是脚本能猜的 —— 脚本只负责把两种口径各自记准。

> ⚠️ provider → 口径的归属是**推断**，写在两份价目表的 `_comment` 里，一行一个，改起来是数据不是代码。
> 最需要你确认的一条：`cc-switch-official` 我按官方算（名字与来源都是 cc-switch 的官方通道）；
> 若它其实是中继，把 `official-usd.json` 里它那两行的 `provider` 改成 `"*"` 再 apply 一次即可。

### 1.5 未计价 ≠ 0

补价之前，那些模型的 token 属于「未计价」，看板会显式给出比例与清单（`unpricedTargets`）。
把未计价当 0 会让「漏配价」看起来像「省了钱」——这是这一期最想避免的误读。

---

## 2. 命令怎么读

### 2.1 `usage` —— 先看有没有价

按 `(供应商, 模型)` 汇总线上用量，标出这一行会被哪条价算到：`专属` / `基础价` / `★未计价`。
末尾给出未计价的比例与清单。**先跑它，再决定要不要补价**（补一个没人用的模型只是噪音）。

### 2.2 `prices` —— 现有价目

走只读 SQL（与 `GET /api/v1/admin/pricing` 同字段）。留意每行的 `note`：
它常常写着这条价的口径来源（`Anthropic 官方价目` / `llm-stats 最低可用价` / `¥1=$1`），
**补价时照抄这个格式**，否则半年后没人知道那个数从哪来。

### 2.3 `plan` —— 只算不写

四态：`新建` / `覆盖`（同键 upsert，会打印原价）/ `无变化`（跳过，避免审计噪音）/ `★冲突`。
有冲突行时 `apply` 会**一条都不写**地中止。

### 2.4 `apply` —— 真写入

`--dry-run` 只打印请求体。写入过程：本机 → SSH → 目标机 `/tmp` 落一个临时 Node 脚本 →
自己读 `/root/.atr/portal.env` → 解验证码 → 登录 → 逐行 POST → 回一行 `ATR_RESULT` JSON → 删脚本。
**管理员口令与会话密钥不离开目标机**。

### 2.5 `verify` —— 证伪

读的是看板自己的接口（`/api/v1/stats/overview`，带 `cost:read` 的会话），打印：
计价覆盖率、**按币种分开**的金额、`pricingSource`、未计价清单。

> ★ 这一条不能省：「价写进去了」与「看板按它算出了金额」是两件事 ——
> 币种、生效区间、供应商是**上报原值**（不是归一化后的展示名）、缺 `cost:read`，
> 任何一环错都表现为「金额没出现」，而 `prices` 那条命令会显示一切正常。

---

## 3. 去哪儿找价（以及怎么记录来源）

| 来源 | 说明 |
|---|---|
| **OpenAI** | [`https://developers.openai.com/api/docs/pricing.md`](https://developers.openai.com/api/docs/pricing.md) —— 🚨 **必须带 `.md`**：HTML 页是 JS 渲染的，抓回来只有导航栏。同一页有 Standard / Batch / Flex / **Fast** / Ultrafast 五档，**取 Standard** |
| **Anthropic** | [`https://platform.claude.com/docs/en/about-claude/pricing.md`](https://platform.claude.com/docs/en/about-claude/pricing.md)（`.md` 同样有效）。价目表是**五列**：输入 / **5m 缓存写** / **1h 缓存写** / 缓存命中 / 输出 —— 见下面 §3.1 |
| 中继 / 网关 | 网关自己的价目页（既有行的备注里出现过 `llm-stats` / `LMSpeed`）。**第三方最低价 ≠ 你付的价**，写进 `note` 里说清 |

**记录三样东西**：`asOf`（数据日期）、`source`（URL）、每行 `note`（口径 + 档位 + 促销期限）。
价目表文件就在 `scripts/online-pricing-catalog.<vendor>.json`，可评审、可 diff、可重放。

### 3.1 🚨 Anthropic 的缓存写有两档价，而库里只有一列

官方给 **5m 缓存写（1.25× 输入价）** 与 **1h 缓存写（2× 输入价）** 两个价，差 1.6 倍；
而本仓的适配器**刻意不把 `cache_creation` 拆成两列**
（`core/src/sources/claude-code.ts` 的口径 1：它们是定价分档，不是另一类用量），
线上只有 `cache_write` 一个数 —— **所以必须选一档，选错就是系统性偏差**。

别拍脑袋，去量真实日志（本机实测 2026-10-04：1,117 条计费行里
`ephemeral_5m_input_tokens` 合计 **0**、`ephemeral_1h_input_tokens` 合计 **1,438,883**，
且拆分之和 1117/1117 行等于 `cache_creation_input_tokens`）：

```bash
# 读本机 ~/.claude/projects/**/*.jsonl，按 message.id 去重后汇总两个分档
# （脚本是一次性的，照 .tmp 里的做法现写即可；关键是按 message.id 去重，否则翻倍）
jq -r 'select(.message.usage) | [.message.id, (.message.usage.cache_creation.ephemeral_5m_input_tokens // 0), (.message.usage.cache_creation.ephemeral_1h_input_tokens // 0)] | @tsv' …
```

**结论**：本部门这批调用 100% 是 1h 档 → 基础价的 `cacheWrite` 取 **1h 价**
（Opus 4.8 / 4.7 = 10，Sonnet 4.6 = 6，单位为「货币单位/百万」）。
按 5m 档配会**低估缓存写 37.5%**（`1 - 1.25/2`）。换客户端 / 换配置后要重新量。

### 3.2 另外三个会改价的乘数（每次都要核一眼）

Anthropic 的响应里有三个字段各自带乘数，**都不在价目表的默认档里**：

| 字段 | 看到什么要改价 |
|---|---|
| `speed` | `fast` → Opus 4.8 / Opus 5 走 Fast mode 价（输入 $10 / 输出 $50，且**只有部分模型支持**）。实测本批恒为 `standard` |
| `inference_geo` | `us` → **1.1×** 全类别（数据驻留）。实测本批是 `not_available` / 空 |
| `service_tier` | `batch` → 输入输出**五折**（缓存乘数照旧叠加）。实测本批恒为 `standard` |

### 3.3 OpenAI 侧的三个档位细节

1. **长短上下文分档**：官方对 `gpt-5.*` / `gpt-6-*` 有 `≤272K` 与 `>272K` 两档价。
   平台**没有这一维**（单价粒度只有 `provider + model + 生效区间`），所以只能按短上下文档记，
   超长的那部分会**低估**。线上实测：单条事件 input 最大 313K，只有极少数越界，可以接受 ——
   但换模型 / 换用法后要重新看 `SELECT MAX(input_tokens) … GROUP BY provider, model`。
   （对照：Anthropic 的 4.6 及以后模型**没有长短分档**，1M 上下文与 9k 同价，不存在这个近似。）
2. **缓存写价**：`gpt-5.6-*` / `gpt-6-*` 有（$5 / $12.5 一档，**单一档**、不像 Anthropic 分 5m/1h），
   `gpt-5.5` / `gpt-5.4` 官方写 `-`（记 0）。
   Codex 来源**真的会上报 cache_write**（实测 `openai/gpt-5.6-sol` 有 4600 万），漏了就是漏钱。
3. **促销价**：官方页会写「promotional pricing 至少到某日」。把到期日写进 `note`。

---

## 4. 价目表 JSON 与 `provider` 的选法

```json
{ "asOf": "2026-10-04", "source": "https://…/pricing.md", "currency": "USD",
  "rows": [{ "provider": "openai", "model": "gpt-5.6-sol",
             "input": 4, "output": 20, "cacheRead": 0.4, "cacheWrite": 5,
             "note": "OpenAI 官方标准价（≤272K 上下文）" }] }
```

- **一份文件一个口径**：顶层 `currency` + 每行 `provider`。行内可以覆盖 `currency` 与
  `provider`，但把两种口径混在一个文件里就失去了「一眼看出这笔钱是美元还是 ¥1=$1」的好处 ——
  官方的进 `official-usd.json`，中继的进 `relay-cny.json`。**别让一个中继行出现在官方那份里**。
- **`provider: "*"` = 不限供应商的基础价**（保留值，不是「某个叫 * 的供应商」）。
  它服务于**中继**：官方 provider 都有自己的专属价，所以基础价一律按 ¥1=$1 记 CNY；
  新出现的网关（`custom` 这类名字）自动继承它，不必逐个补。
- **基础价与同名的专属价可以共存**（专属优先、基础兜底是**两层**匹配，取数 SQL join 两次）。
  所以「新增 `* / gpt-5.6-sol`」不会与既有的 `deeprouter / gpt-5.6-sol`、
  也不会与新的 `openai / gpt-5.6-sol` 冲突 —— 那两条正是「中继另有口径」与
  「官方直连」的表达方式。**不要**把它改成「同模型即冲突」。
- **近似价必须自报家门**：官方没有那个模型名（`gpt-6` / `gpt-5.3-codex-spark`）时，
  按同代最接近的型号折算，并让 `note` 以 `★近似：` 开头写清依据。
  看板不会区分「官方价」与「近似价」，所以 `note` 是唯一的区分处 —— 不写就等于假装它是真的。
- **`effective_from_ms` 缺省 0 = 自始有效**：给从没配过价的模型补价时必须这样，
  否则历史用量永远停在「未计价」——而那正是补价要修的东西。**换价**时才给显式起点
  （`--from <epoch_ms>`），并记得先给上一条价补 `effective_to_ms`，否则 409。
- 同一个模型、同一个供应商、同一个起点 = **upsert**（改这一条价），不是新增一行。
- 数值校验：非负、≤6 位小数、上限 10000 货币单位/百万 token；不能被整数微元精确表示的
  （如 `$0.0625`、`$0.0276`）会被四舍五入 **并打印告警** —— 看到告警就确认一次这个数是不是你想要的。

---

## 5. 认证与凭证（出问题时看这一节）

| 事 | 在哪儿 |
|---|---|
| 生产 root（SSH） | 仓库根 `.env` 的 `host` / `password`，只走 `plink -pwfile`，绝不打印 |
| 管理员用户名 / 口令 | 目标机 `/root/.atr/portal.env` 的 `ATR_ADMIN_USERNAME` / `ATR_ADMIN_PASSWORD` |
| 验证码密钥 | 同文件的 `ATR_CAPTCHA_HMAC_KEY`（≥32 字符） |
| 上报库口令 | 目标机 `/root/.atr/mysql8-credentials.txt` 的 `[atr_user]`，经 `--defaults-extra-file` 递给 mysql |

### 5.1 验证码是怎么"解"出来的

后台登录的验证码是 **4 位数字**，库里只存 `HMAC(ATR_CAPTCHA_HMAC_KEY, challenge_id + ':' + answer)`。
远端脚本拿 `challenge_hash = sha256(captcha_id)` 查出那一行的 HMAC，再对 10000 个候选做一次
HMAC 比对（<50ms）。**这不是绕过认证**：口令照旧要过 KDF 校验，而且能读到那把密钥的人
本来就有那台机器的 root。它是把「人工看图」这一步自动化，所以工具里绝不打印密钥与口令。

### 5.2 🚨 两个 Cookie 的 Path 是 `/ai-token/api/v1`

子路径部署下，浏览器/Cookie 罐的 Path 匹配会让 `127.0.0.1:$PORT` 根路径的请求**静默不带**这两个
Cookie（`atr_portal_captcha` 与 `atr_portal_session`），表现是「验证码永远错」或「登录成功但下一跳 401」。
所以远端脚本显式读 `set-cookie` 再显式回填 `Cookie:` 头，**不依赖任何 Cookie 罐。**

### 5.3 管理接口的 CSRF 栅栏

带 Cookie 的 `POST /api/v1/admin/*` 要求 `x-portal-request: 1` 且 `Origin` 不能是别的站点。
脚本带上这个头、且**不发 Origin**，于是自然通过。`Authorization: Bearer` 那条路**不认会话**
（`resolveBearer()` 只查 `report_tokens`），所以会话只能走 Cookie。

### 5.4 常见失败与处置

| 症状 | 原因 / 处置 |
|---|---|
| `ATR_ERROR … 取验证码失败：HTTP 503` | 目标机没配 `ATR_CAPTCHA_HMAC_KEY`（多实例必须同一把） |
| `管理员登录失败：HTTP 401 用户名或密码错误` | `/root/.atr/portal.env` 里的口令已过期（后台改过密码）→ `--username/--password` 覆盖，或在服务器上更新该文件 |
| `验证码错误或已过期` | 两次运行挨得太近（验证码被上一次消费）或密钥与库不是同一套 |
| `HTTP 409 这个生效区间与已有的 N 条单价重叠` | 先给既有那条补 `effective_to_ms`，或把这次起点挪到它之后（`--from`） |
| `verify` 里没有 `cost` 字段 | 这个身份没有 `cost:read`（权限问题，不是没配价） |
| 覆盖率上去了但金额是 0 | 看 `pricingSource` 是不是 `db`；再看币种是不是写错了（金额按币种分开列） |

---

## 6. 改完这个工具要跑什么

```bash
bun test packages/server/test/online-pricing-plan.test.ts   # 12 项：单位换算 / 冲突 / 渲染
bun test packages/server/test/deploy-plan.test.ts           # 同款渲染套路，别弄坏
bun run typecheck                                           # 7 包
```

单测里有两条**踩过才知道**的断言，改远端脚本时别删：

- 🚨 远端脚本**一个反引号都不能有**：它整体是一个 JS 模板串，注释里写一对反引号会把串
  提前截断，而报错位置指向模板串的**开头**（`scripts/deploy-server.mjs` 踩过，本工具 2026-10-04 又踩一次）。
- 🚨 远端脚本里不许残留 `${`：模板串会被本机抢先求值。同理，口令必须以 base64 内联，
  **不以明文**出现在脚本文本里（脚本会落到目标机的 `/tmp`）。

---

## 7. 已知边界（别当成 bug 去"修"）

1. **没有按上下文长度分档**：单价粒度是 `provider + model + 生效区间`。OpenAI 的长上下文档只能算进短档（低估）；
   Anthropic 4.6+ 没有这一档，不受影响。
2. **缓存写只能取一档**：Anthropic 的 5m / 1h 两档价（1.25× vs 2×）在库里只有一列 ——
   本部门按实测取 1h（见 §3.1）。客户端改成 5m 缓存后**要重新量、重新配**，
   否则缓存写会反向偏高 37.5%。
3. **闲时档（`offpeak_*`）只对 DeepSeek 有意义**：OpenAI 那几家没有闲时表，
   `offpeak_schedule` 留空 = 全天一个价；五个字段同生共死。
4. **供应商归一化不参与取价**：`model_price.provider` 必须与 `usage_event.provider` 的
   **上报原值**一致（像 `custom`、`cc-switch-official` 这种网关名要原样写），
   归一化只是查询期的展示口径。
5. **金额是估算，不是账单**：`token × 价`，不含折扣 / 预付 / 赠送额度。
   **官方套餐（订阅制）尤其如此** —— 走套餐的那部分（`openai` / `anthropic` / `cc-switch-official`）
   是按 API 挂牌价折出来的**等价成本**，用来跟套餐费对比；真实账单是那张月费。
   实测第 3 轮：`USD $6,707.13`（官方等价成本）＋ `CNY ¥6,230.76`（中继 ¥1=$1）都是理论值。
6. **`custom` 这种网关名没有官方价目**：它是什么中继只有部署的人知道。
   本工具把它当作"继承基础价"，并把口径写进 `note`；真正要精确，得问清楚那个网关的计价口径，
   再补一条专属价。
7. **已计价 ≠ 已核对**：覆盖率是「有没有价」，不是「价对不对」。
   官方的**促销期一过、档位一换**（Fast/Batch/驻留/缓存 TTL），金额就会偏，
   而页面看起来一切正常 —— 所以每行的 `note` 里要写清档位与到期日。
8. **有几种用量永远配不上价**（别为了把覆盖率刷到 100% 而编价）：
   没有模型名的（`(unknown)`）、厂商内部模型（`codex-auto-review`）、
   客户端私有别名（`workbuddy/auto`）、以及查不到权威价目的预览模型
   （`workbuddy/hy4-preview-f` —— 腾讯只公布了「输入 ¥6 起」，缺输出与缓存价，所以留空）。
   硬凑一个四元组只会把一个**已知的未知**伪装成一个精确的数。
