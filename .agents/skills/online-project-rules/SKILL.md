---
name: online-project-rules
description: 给线上的部门服务端配「项目归一化规则」时用（117.72.173.21/ai-token 的「项目归一化」页背后那张 project_alias 表）。Use when folding messy cwd values into named projects on the production dashboard, writing project_alias rows through the admin API, or checking that the dashboard really groups by the new names; not for provider/model normalization (that is online-model-pricing's sibling concern) and not for the local project() derivation (`packages/core/src/aggregate.ts`).
version: 1.0.0
---

# 操作线上项目归一化规则

管的是**线上那张 `project_alias` 表**：看板的「项目」维度怎么把五花八门的 `cwd` 折成**一个项目口径**。

**不管**：供应商 / 模型归一化（`provider_alias`，见 `online-model-pricing` skill 的 §7.4）、
本机库的 `projectName()` 口径（`packages/core/src/aggregate.ts`，本机/CLI/插件**没有**规则表）、
以及 `cwd` 的上报原值（规则是**查询期**的，一个字节都不改写 `usage_event`）。

工具两个文件：

| 文件 | 职责 |
|---|---|
| `scripts/online-project-rules.mjs` | 操作台：`rules` / `plan` / `apply` / `prune` / `verify` |
| `scripts/online-project-rules-plan.mjs` | 纯逻辑：匹配模式判定、前缀归一化与校验、计划判定、HEX 解码（被 `packages/server/test/online-project-rules-plan.test.ts` 钉住） |

远端登录与写入复用 `online-pricing-plan.mjs` 的 `REMOTE_APPLY_SOURCE`（只把**端点**参数化）——
认证、解验证码、会话显式回填这些最容易错的环节**只有一份实现**。
凭证位置、验证码怎么解、Cookie Path 与 CSRF 栅栏、常见失败处置，**全看
`online-model-pricing` skill 的 §5**（那一节两个工具通用）。

---

## 0. 五分钟走完

```bash
bun scripts/online-project-rules.mjs rules                       # ① 线上现有规则（只读）
bun scripts/online-project-rules.mjs plan  --file <rules.json>    # ② 算计划（只读）
bun scripts/online-project-rules.mjs apply --file <rules.json>    # ③ 真写入
bun scripts/online-project-rules.mjs prune --file <rules.json>    # ④ 清掉不在目录里的旧规则（演练）
bun scripts/online-project-rules.mjs verify --from 0              # ⑤ 读看板 by=project，核对真的归好组
```

⚠️ **用 `bun` 跑**（不是 `node`）：`ssh-exec.mjs` 的 `which('plink')` 依赖完整 PATH，
受限环境里 `node` 会 spawn 失败并误报「既没有免密 ssh，也没找到 plink」。

⚠️ **改了 `packages/core/src/db/project-alias.ts` 的匹配语义就要先部署**（见 §1.3），
否则新写的规则一条都不生效，而 `rules` 看起来一切正常。

---

## 1. 五条铁律

### 1.1 🚨 查询期归一化，事件原值一个字节都不改

规则的载体是 `project_alias`，`usage_event.cwd` 永远是上报当时的原值。
改一条规则**立刻对历史生效**、随时改回去，**不需要任何回填脚本**。
所以「配错了」的代价是看一眼数字不对，而不是一次不可逆的数据改写。

### 1.2 🚨 优先填**仓库名**（不含路径分隔符），而不是完整路径

一个 `prefix` 字段承载**两种**语义，靠「有没有路径分隔符」区分：

| 写法 | 例 | 命中范围 | 什么时候用 |
|---|---|---|---|
| **仓库名**（不含分隔符） | `suit-g92-parent` | cwd 的**任一路径段**逐字等于它 | **绝大多数情况** |
| **路径前缀**（含分隔符） | `D:\Coding\suit-g92-parent` | 整条路径前缀（按分隔符边界） | 要把同名仓库**限定在某几个位置** |

**为什么主推仓库名**：路径模式下换盘（`D:` / `F:`）、换父目录（`Coding` / `Coding_agent`）、
换盘符大小写（`D:\` / `d:\`，不同客户端写法不同）**各要一条规则**。
实测线上 10 个项目要 **31 条**，其中 8 条纯大小写变体、5 条跨根 checkout。
仓库名模式把这三类差异一次消掉：同样 10 个项目 **14 条**（2026-10-04 实测）。

⚠️ 仓库名仍是**逐字全等、区分大小写**：`skills-cli` 不命中 `skills-cli-old`，
`Foo` 不命中 `foo`。段名前缀 / 大小写折叠都会把两个不同目录**悄悄并起来**，那个方向的错误页面上看不出来；
而漏配一个变体的后果是**可见的**（用量偏小，去明细页一看就知道）。
真实数据里仓库名的大小写变体只有盘符（`D:` / `d:`），而盘符在仓库名模式下**不参与匹配**，
所以这条约束在仓库名模式下几乎不产生代价。

🚨 **裸盘符 `D:` 会被服务端拒**：它**本身就是** `D:\a\proj` 的第一段
（切段结果 `['D:', 'a', 'proj']`），一条 `D:` 会匹配该磁盘下的**每一个**目录。
`D:\`（带尾分隔符）放行 —— 它含分隔符，走路径模式。

### 1.3 🚨 换匹配语义时，**先部署再改规则**

线上代码只认它认识的那两种模式。服务端没部署仓库名模式就写入裸名规则 ⇒
**一条都不会生效**，而 `rules` 命令会显示「规则都在」，看板毫无变化。

| 步骤 | 动作 |
|---|---|
| 1 | 部署含新匹配语义的服务端 |
| 2 | `apply` 写入新规则 |
| 3 | `prune --yes` 删掉不在目录里的旧规则 |
| 4 | `verify` 读看板核对 |

不 `prune` 的后果：两批规则并存（写入是 upsert，顶不掉旧的前缀），
看板数字仍对（都指向同一个项目名），但「哪条压住哪条」再也说不清，
删改任意一条都会让口径在没人预期的时候变一次。

### 1.4 🚨 写数据走管理接口，不直接改库

库里那条 UNIQUE 索引是 `(member_id, prefix)`，而**含 `NULL` 的行它拦不住**
（两种后端都一样）。也就是说「同一个前缀只能有一条**全局**规则」这件事
**只有应用层在保证**（`repository.setProjectAlias()` 的 `findProjectAlias()` 查重）。

直接 `INSERT` 能绕过它，代价是同一条目录上并存两条全局规则：
归一化时取「最早的一条」（`projectAliasesToMap` 的 `??=`），结果是
**「页面上看着改了、实际还按旧名字走」**，而且两条规则都自圆其说。
走接口还顺带有审计行（`admin_audit_log`）与事务内重鉴权。

工具里的读（`rules` / `plan`）走**只读 SQL**（少一次登录，且 `renderSqlProbe()` 有只读闸门）；
只有 `apply` 走接口。

### 1.5 🚨 读现有规则必须走 `HEX()`

`mysql --batch` 会把数据里的 `\` 转义成 `\\`，而这里的前缀**全是** Windows 路径。
直接 `SELECT prefix` 拿回来的值与本文件里的前缀逐字不同 →
**每一条都被判成「新建」**，第二遍跑就写出一堆重复行（那是**静默**的：`plan` 看起来完全正常）。

`EXISTING_RULES_SQL` 因此用 `HEX(prefix)` / `HEX(alias)`，本机解码。
单测里有一条断言专门防「顺手简化回 `SELECT prefix`」。

⚠️ 该 SQL **必须带 `alias_id`**：删除端点只收 `alias_id`
（业务主键是 `(scope, member_id, prefix)`，删不了），缺了它就只剩「停用」而不能真删。

### 1.6 先抓反例再算计划：用**真实 cwd 清单**反查每条规则

空转的规则（命中 0 个目录）说明前缀写错了，而 `plan` 不会告诉你这件事
—— 它对每一条都是「新建」，看起来一样正常。**配规则的标准动作**：

```bash
# ① 拉线上真实 cwd 分布（只读）
bun run packages/server/verify/perf/online-probe.ts --file <按 cwd 分组的 SQL> > cwd.txt
# ② 用 cwd.txt 反查：「每条规则命中几个目录 / 有没有 0 命中 / 折叠前后差多少行」
#    一次性脚本照 `.artifacts/project-grouping/check-coverage.mjs` 写即可
```

⚠️ 解析 `online-probe` 的输出时，反斜杠被 `--batch` 转义成了双写，
必须 `replace(/\\\\/g, '\\')` —— 否则所有 Windows 前缀都静默不命中。

---

## 2. 命令怎么读

### 2.1 `rules` —— 现有规则（只读）

打印 `作用域 / 归属 / 目录前缀 / 归一化名 / 启用`。0 条时明确提示
「项目维度取 `cwd` 最后一段」——**先跑它**，再决定要配什么。

### 2.2 `plan` —— 只算不写

三态：`新建` / `覆盖`（同前缀 upsert，会打印原名与「原来是停用的」）/ `无变化`（跳过，避免审计噪音）。

判定只与**全局**规则比（`scope='global'` 且 `member_id IS NULL`）：
同一条目录上「我的名字」覆盖「部门的」是**两层**语义，不是冲突 ——
把个人规则也算进"已存在"会让一次全局改名被**静默跳过**。

### 2.3 `apply` —— 真写入

`--dry-run` 只打印请求体。逐行 POST `/api/v1/admin/project-aliases`
（`body` 只有 `scope` / `prefix` / `alias` 三个键 —— schema 是 `strictObject`，
而 `enabled` 缺省即 true、`member_id` 只在 `scope='member'` 时有意义）。
**每行成败各自独立**，一行被拒不会连累其余行。

写入过程：本机 → SSH → 目标机 `/tmp` 落临时 Node 脚本 → 读 `/root/.atr/portal.env`
→ 解验证码 → 登录 → 逐行 POST → 回一行 `ATR_RESULT` JSON → 删脚本。
**管理员口令、验证码密钥与会话不离开目标机。**

### 2.4 `prune` —— 删掉「不在目录里」的旧规则

`--file <rules.json>` 指定**期望的最终规则集**；线上多出来的会被删掉。
业务主键是 `(scope, member_id, prefix)`（都先过 `normalizeProjectPrefix`）。

🚨 **默认是演练**，打印要删什么就结束，`--yes` 才真删。理由：
这是本工具**唯一会减少线上数据**的操作（其余是 upsert，重复跑无害），
而目录文件写错一个字符就会把全部现有规则判成「不在目录里」。

走 `DELETE /api/v1/admin/project-aliases`，body 是 `{ alias_id }`，逐行独立成败。

### 2.5 `verify` —— 证伪（不能省）

读的是**看板自己的接口**（`/api/v1/stats/breakdown?by=project`，带 `stats:read` 的会话），
打印每个项目的总 token 降序 + **行数**。

> ★ 「规则写进去了」与「看板真的按它归好组了」是**两件事**：
> 服务端读的是**上报库**的规则表（可能不是你以为的那个库）、规则 `enabled=0`、
> 前缀与上报原值差一个字节（大小写或尾部分隔符）—— 任何一环错都表现为
> 「项目名没变」，而 `rules` 那条命令会显示一切正常。

### 2.6 一个反直觉但正确的现象

**未配规则的目录会「回落」到 `cwd` 最后一段**（`projectName()`，故意不是空串也不是 `other`）。
所以某目录若天然叫「售前知识库」，它会**自动**与规则命中的「售前知识库」并成一行 ——
不是 bug，是回落语义的直接后果。实测：`D:\Coding\售前知识库`（未配规则）就这样并进了
`D:\Coding\presales-kb-parent`（配了规则）的那一行。

---

## 3. 规则目录 JSON

```json
{ "asOf": "2026-10-04", "source": "线上 usage_event.cwd 实测分布（195,376 条 / 201 个目录）",
  "rows": [{ "scope": "global", "prefix": "suit-g92-parent", "alias": "甬舟G92项目" }] }
```

- **`scope` 只写 `global`**：个人规则要 `member_id`，而那是会变的东西，本工具拒绝写
  （要配个人规则请走管理页）。
- **`prefix` 填仓库名**（不含 `\` 与 `/`），如 `suit-g92-parent`。
  路径前缀写法（`D:\Coding\suit-g92-parent`）仍然合法，`\` 在 JSON 里要写成 `\\`。
  尾部路径分隔符会被归一化（`D:\a\` ≡ `D:\a`）。
- **`alias` 允许中文**（这正是本功能的目的），也允许 `/`；上限 128 字符。
  前缀上限 512。两者与 `portal-schema-v11.ts` 的 DDL CHECK 同值。
- **同一项目 = 同一个 `alias`**：一个项目可以关联**多个仓库名**（如「技能仓库」同时
  认 `skills-cli` 与 `suit-skills-cli`），写多条规则指向同一个名字即可。
- **空 `rows` 一律报错**：算出「零条规则的成功计划」最危险 ——
  运维会以为已经生效，而看板一个字节都没变。
  （`prune` 也因此格外危险：**空目录 = 删掉全部规则**。）

### 3.1 匹配语义（写规则前必须知道）

| 规则 | 说明 |
|---|---|
| **仓库名 = 段全等** | `suit-g92-parent` 命中该仓库在**任意磁盘、任意父目录**下的所有子目录；**不**命中 `suit-g92-parent-old` |
| **路径前缀 + 分隔符边界** | `D:\a\proj` 命中 `D:\a\proj` 与 `D:\a\proj\src`，但**不**命中 `D:\a\proj-other` |
| **逐字比较** | 区分大小写（见 §1.2 的理由） |
| **优先级：路径模式 > 仓库名模式** | 路径模式是「显式限定位置」的一次陈述，更具体；同类型内最具体者胜出 |
| **同长时人员规则覆盖全局** | 与 `provider_alias` 同源 |
| **未命中回落** | 回到 `projectName()`（`cwd` 最后一段），**不是**空串也不是 `other` |

判定入口 `isProjectPathRule()` 在 `packages/core/src/db/project-alias.ts`，
`scripts/online-project-rules-plan.mjs` 有一份**必须逐字等价**的复述版
（它要能在 node 下跑、不 import TS）—— 裸盘符那条校验两边分叉的表现是
「前端放行、服务端 400」。三处等价点见 §1.2。

---

## 4. 改完这个工具要跑什么

```bash
bun test packages/server/test/online-project-rules-plan.test.ts   # 11 项：归一化 / 校验 / 计划 / HEX / DELETE
bun test packages/server/test/online-pricing-plan.test.ts         # 13 项：远端脚本渲染（别弄坏）
bun test packages/core/test/project-alias.test.ts                 # 43 项：匹配语义（本工具的口径源头）
bun run typecheck
```

⚠️ 改了 `project-alias.ts` 的匹配语义，还要跑 `bun test packages/core/test/`（整包 570 项）
与 `bun test packages/server/test/http-contract.test.ts`（114 项，**单独跑**）。

单测里有两条**踩过才知道**的断言，改远端脚本时别删：

- 🚨 远端脚本**一个反引号都不能有**：它整体是一个 JS 模板串，注释里写一对反引号会把串
  **提前截断**（2026-10-04 本工具真踩了一次：加了一句带反引号的注释，
  报错指向 `online-pricing-plan.mjs:374` 那个「函数名」，排查方向整个跑偏）。
- 🚨 远端脚本里不许残留 `${`；口令必须 base64 内联，**不以明文**出现在脚本文本里。

另外：本文件的工具**复用了** `online-pricing-plan.mjs` 的 `REMOTE_APPLY_SOURCE`
（通过 `CONFIG.endpoint` 与逐行的 `CONFIG.rows[].method` 参数化）。
改那一段时，**两个 skill 的单测都要跑**。

### 4.1 验证脚本：直接 import 真的 core 实现

`.artifacts/project-grouping/verify-repo-name.mjs` 是本工具配套的离线验证：
它 **import `packages/core/src/db/project-alias.ts`**，而不是复述一遍匹配语义 ——
抄写本身可能与实现分叉，而分叉出来的结论会让人以为验证过了。

它回答四个问题：14 条规则在真实 201 个 `cwd` 上命中多少 / 漏掉多少；
与旧路径规则是否**逐项目逐位一致**；有没有误伤；有没有「一条都没命中」的空转规则。

⚠️ `.mjs` 里**不能写 `import { type Foo }`**（`type` 是 TS 语法），要用的类型就在本文件里重声明一个。

---

## 5. 已知边界（别当成 bug 去"修"）

1. **归一化只在「上报库」这条路径上生效**：本机库（`usage.sqlite`）没有 `project_alias` 表，
   本地页面 / CLI / 插件面板仍是 `projectName()` 的旧口径。「本地看到的项目」与「看板看到的项目」
   可能不同名，这是**刻意的**：项目别名是部门口径，不是本机口径。
2. **不配规则的目录保持自身**（回落到最后一段），不是「变成 other」——
   漏配一条规则的后果是「它单独占一行」，不是静默的错误名字。
   代价：**没有规则 = 没有信号告诉你有东西没配**，所以 `check-coverage` 那一步不能省。
3. **临时目录不会被自动清掉**：Open Design 的 uuid 项目目录、Codex 的日期目录
   会各占一行。要不要给它们配一个「临时目录」把噪音收起来是**人的决定**
   （收了就再也不容易发现「原来有东西跑在临时目录里」）。
4. **仓库名模式会多命中 worktree / 副本目录**：段匹配不关心它在哪个盘，
   所以 `.codex\worktrees\5ed7\skills-cli` 这种**代码生成的副本**也会被算进
   `skills-cli`。实测那个目录 18 事件 / 1.09M —— 归到同一个仓库名下**方向上是对的**
   （它确实是那个仓库的 worktree），但要意识到「路径模式刻意漏掉、仓库名模式会吃进来」。
5. **跨人合并是口径决定，不是技术问题**：把另一位成员的 checkout 并进你的项目
   （如 `F:\vue_code\suit-g92-parent`）会让两个人的用量并成一行 ——
   按「业务项目」看也许对，但要知道这一点；改回来就是改一条规则的 `alias`。
6. **同名前缀的兄弟仓库要各配一条**（`skills-cli` 与 `suit-skills-cli`）——
   段匹配是全等而不是段名前缀，刻意不吃掉它们。代价是「每个都要配」，
   换来的是「不会把两个不同仓库悄悄并成一行」。

---

## 6. 实测记录

### 6.1 第一轮：路径前缀模式（2026-10-04 上午）

线上 `project_alias` 从 **0 条** → **31 条规则 / 10 个项目**，看板项目维度
**144 行 → 125 行**。规则目录：`.artifacts/project-grouping/project-rules.json`。

| 项目名 | 目录前缀条数 | 折叠前 | 折叠后 token |
|---|---|---|---|
| 售前知识库 | 2（`D:\Coding` + `D:\Coding_agent`） | 5 行 | 4,940,695,190（★ 全站第一） |
| AI Token 用量平台 | 3（含一个 `d:\` 变体） | 1 行 | 4,437,271,075 |
| 甬舟G92项目 | 3（+`F:\vue_code`，**另一成员的 checkout**） | 6 行 | 4,351,926,694 |
| 黑客松轨交文档审查智能体 | 4（两个根 × 两个大小写） | 3 行 | 1,527,619,149 |
| 技能仓库 | 4（`skills-cli` 2 + `suit-skills-cli` 2） | 2 行 | 973,082,443 |
| 接口改MCP服务 | 1（父目录覆盖 3 个子目录） | 3 行 | 603,178,617 |
| 建元资管项目 | 4（`suit-jyzg-*` 3 + `stec-jyzg-parent` 1） | 5 行 | 269,710,019 |
| 申迪项目 | 6（`-page` + `-invest-page` × 两个根 × 两个大小写） | 2 行 | 243,663,141 |
| 一体化项目 | 2（两个根） | 4 行 | 162,132,396 |
| 三维场景工具 | 2（两个大小写） | 2 行 | 119,265,038 |

**幂等性实测**：`apply` 31/31 返回 200 → 再跑 `plan` 是 **31 条「无变化」、0 条要写**。

### 6.2 第二轮：换成仓库名模式（2026-10-04 下午）

**31 条 → 14 条**（同 10 个项目），规则目录：
`.artifacts/project-grouping/project-rules-repo-name.json`。
用**真实 core 实现**跑线上 201 个目录的结果：

| 口径 | 规则条数 | 看板项目行数 | token 合计 |
|---|---|---|---|
| 无规则 | 0 | 144 | 25.910B |
| 路径前缀模式 | 31 | 125 | 25.910B |
| **仓库名模式** | **14** | **124** | 25.910B |

- **总量守恒**：折叠只改分组，不改 token。
- **10 个项目里 9 个逐位一致**；唯一差异是「技能仓库」+5 万 token
  —— 来自 `.codex\worktrees\5ed7\skills-cli`（见 §5.4），**是修正不是误差**。
- **14 条全部命中真实目录**，0 条含分隔符（会被误当路径模式），0 条空转。
- 未命中：139 个目录（8.371B）按旧口径显示。

**留待确认（刻意没配）**：

| 目录 | 事件 / token | 为什么没并 |
|---|---|---|
| `D:\Codewangs\yth\suit-yth-product`、`D:\Codewangs\gitee\suit-front-promis-module-yth` | 1,633 / 508M | 看着是一体化项目，但在**另一位成员**的 `D:\Codewangs` 根下 —— 跨人合并要拍板 |
| `D:\Document\G92甬舟项目` | 17 / 0.99M | 名字像，但它是**文档目录**不是代码 checkout |
| `D:\Coding\suit-promis-front-module-jyzg` | 8 / 0.14M | 看着是建元资管，但不在 `suit-jyzg-parent` 下 |

⚠️ **第二轮未执行线上写入**：工作区里有**别人未提交的 pricing/cost 在途改动**
（`repository.ts` 删了 `seedModelPrices`、`cli.ts` 处于语法错误状态），
`bun run deploy` 会把它们一并推上线。切换步骤见 §1.3。
