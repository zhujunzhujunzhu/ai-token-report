---
name: auto-commit-push
description: Split uncommitted work into one commit per functional point and push each to the remote immediately, without asking for confirmation. Use when the user says 提交推送 / commit and push my changes / 按功能点提交 / 帮我 commit 一下并推送; not for reviewing code quality, resolving merge conflicts, or rewriting already-pushed history.
version: 1.0.0
---

# 按功能点提交并推送

**这个 skill 的目标只有一个：把工作区里散落的一坨改动，
变成远端仓库上一串「每个 commit 只讲一件事」的历史。**

执行者（你）要**全程自动**：不逐条征求确认，不中途停下来问
「这样可以吗」。用户已经在这个 skill 里表达了「直接做」的授权。

---

## 0. 三条铁律

| # | 规则 | 违反了会怎样 |
|---|---|---|
| 1 | **一个 commit 只对应一个功能点** | 拆成「杂项改动」的大 commit = 这次执行白做 |
| 2 | **每条 commit 后立刻推送当前分支** | 用户要的就是「本地即有远端」；攒到最后一次推，中途失败会长短不一 |
| 3 | **绝不提交密钥 / 运行时数据 / 无关文件** | 推送是**不可撤销**的，密钥进了远端历史就得轮换凭证 |

> **为什么铁律 1 排在推送前面**：推送只是传输动作，真正的价值在拆分。
> 一个「修了 bug 也顺手改了文档还调了格式」的 commit，
> 在 `git log` 里和「一堆没提交的改动」信息量是一样的。

---

## 1. 执行流程（照做）

### 第 1 步：摸清状态（必须先做，不可跳）

```bash
git status --short
git diff --stat                    # 未暂存的改动规模
git diff --cached --stat           # 已经暂存的（用户可能已经 add 过）
git log --oneline -10              # 跟随本仓既有的提交信息风格
git rev-parse --abbrev-ref HEAD    # 当前分支名，推送要用
git remote -v                      # 确认远端存在
```

**同时**判断三件事，任何一件不满足就先处理，不要硬着头皮提交：

| 检查 | 不满足时 |
|---|---|
| 有远端吗 | 没有 → 停止，告诉用户需要先配 remote，**不要**改成只提交本地 |
| 当前在哪个分支 | 在 `main` / `master` 且本仓有分支约定 → 按仓约定决定，不确定就照常推当前分支（用户已选「推当前分支」） |
| 有未完成的 merge / rebase 吗 | `git status` 显示 `MERGING` / `REBASING` → 停止并报告 |

### 第 2 步：把改动切成功能点

**逐个文件、必要时逐个 hunk 地看**，而不是只看文件名的目录分组。分组依据是
**「这次改动解决了什么问题」**，不是「这些文件在同一层目录」。

看 diff 的命令：

```bash
git diff -- <path>                 # 单文件全部改动
git diff --stat                    # 先看规模，决定要不要逐个 hunk 拆
```

**判定一个改动属于哪个功能点，问这三个问题：**

1. 它**为什么**被改？（修 bug / 加功能 / 改文档 / 调格式 / 升依赖）
2. 去掉它，另一个改动还成立吗？**不成立 → 它们必须同属一个 commit。**
3. 它能被**独立回滚**吗？不能 → 说明和第 2 问沾边，合并进去。

**同一文件的不同 hunk 常属于不同功能点**，这不算罕见情况：
比如 `cli.ts` 里一处修了退出码、另一处加了个新参数，那就是两个 commit。
用 `git add -p` 或 `git apply --cached` 拆开，别因为「都在一个文件里」就合并。

**常见的功能点划分（按优先级排序）：**

| 类型 | 例 | commit 前缀 |
|---|---|---|
| 契约 / 字段变更 | 改 DTO、DB 列 | `feat` |
| 内核逻辑 | decode / aggregate / scan | `fix` / `feat` |
| 测试 | 跟着上面一起，或单独补 | `test` |
| 文档 | `README` / `ARCHITECTURE` / skill | `docs` |
| 工程配置 | `package.json` / `tsconfig` / CI | `chore` |
| 纯格式化 | 无行为变化的空白 / 引号 | `style`（尽量并入相关 commit） |

### 第 3 步：逐条提交 + 逐条推送

对每一个功能点，重复下面三步。**做完一个再做下一个**，不要批量 add 完再批量 commit。

```bash
# ① 只暂存这个功能点涉及的内容（逐 hunk 时用 -p）
git add <paths...>
#   或：git add -p <path>

# ② 核对暂存区 —— 这一步不能省
git diff --cached --stat
git diff --cached                  # 确认没有夹带无关改动

# ③ 提交并立刻推送
git commit -m "<type>(<scope>): <中文描述>"
git push origin HEAD
```

**未建立上游时**第一次推送用：

```bash
git push -u origin HEAD
```

> `git push origin HEAD` 比 `git push` 更稳：即使当前分支没设上游、
> 或上游名字不叫 `origin`，它推的也一定是**当前检出的这个分支**，
> 不会出现「以为推了 feature 分支，其实推了别的」。

**推送后核对**：`git status --short` 应显示工作区里属于该功能点的文件已消失，
`git log --oneline -1` 应显示刚提交的这条。若 `git push` 报
`non-fast-forward` / `rejected`，**停下报告**，不要 `--force`
（见 §3）。

### 第 4 步：收尾报告

全部完成后，给用户一份**逐条清单**：

```
✅ 推送完成（分支 feat/xxx → origin/feat/xxx），共 4 条：

1. a1b2c3d  feat(shared): 新增 cacheWrite 字段到上报 DTO
2. d4e5f6a  fix(core): 修正时间分桶在 UTC 下的偏移
3. 7h8i9j0  test(core): 补分桶边界的回归断言
4. k1l2m3n  docs: 补充本地库降级路径说明
```

**如果还有没提交的残留**（比如你判定为不该提交的文件），必须单独列出来
并说明**为什么没提交** —— 静默丢下东西是最糟的收尾。

---

## 2. 提交信息怎么写

- **中文描述**（本仓约定，见 `repo-conventions`），`type(scope): 描述` 格式。
- 描述写**「为什么」**，不是「改了什么」：
  - ❌ `fix: 修改 aggregate.ts`
  - ✅ `fix(core): 时间分桶改在 JS 侧做，SQL 的 localtime 在测试环境差 8 小时`
- **先看 `git log`**：本仓已有风格就跟随，不要凭空发明一套。
- 一次提交**只讲一件事**。`and` / `顺便` / `同时` 出现在信息里，
  通常说明该拆成两条。

---

## 3. 🚨 绝对不做的事

| 禁止 | 原因 |
|---|---|
| `git push --force` / `-f` | 会覆盖别人已推的提交，是**不可恢复**的破坏 |
| `git commit --amend` 已推送过的 commit | 同上，且会让远端与本地分叉 |
| `git add -A` / `git add .` 一把梭 | 会把 `.env`、`*.db`、密钥、临时文件带进历史 |
| `git reset --hard` / `git checkout .` 丢改动 | 用户的工作可能没备份，**这是数据丢失** |
| 提交 `.env` / 凭证 / `*.db` / `*.jsonl` | 推送不可撤销，密钥泄露只能轮换 |
| 跳过 `git diff --cached` 直接 commit | 夹带无关文件是这一步唯一的拦截点 |

**遇到 `rejected` / 冲突 / 保护分支拒绝**：停止，把原始错误信息
**原文**贴给用户，说明需要什么决策。不要自作主张 rebase 或 force。

**不确定的文件该不该提交**：**不提交**，在收尾报告里列出来问。
少提交一个文件可以补一次 commit；误提交一个密钥，代价是轮换整套凭证。

> ⚠️ 本仓 `.gitignore` 已排除 `node_modules/` / `dist/` / `*.db` /
> `*.jsonl` / `token-report-user.json` / `.env`。**文件没出现在
> `git status` 里就是被忽略了，不要用 `git add -f` 强行加进来。**

---

## 4. 边界情况

| 情况 | 怎么办 |
|---|---|
| **工作区是干净的** | 直接报告「没有需要提交的改动」，**不要**创建空 commit |
| **只有一个功能点** | 就一条 commit，不要为了「看起来丰富」硬拆 |
| **改动巨大（几十个文件）** | 先按包 / 模块分组提交，再在组内看是否需要细分；规模大时优先保证**不夹带**，而不是拆到最细 |
| **用户已经 `git add` 过一部分** | 尊重它。先 `git diff --cached` 看清是什么，作为第一个功能点的起点 |
| **有 untracked 的新文件** | 确认它**属于哪个功能点**再 add；新文件常被漏掉，别只顾着改动的文件 |
| **删除了文件** | `git add` 同样要包含删除（用 `git add -A <path>` 或 `git add <path>` 对已删文件也生效） |
| **远端仓库还没建** | 停止并报告，不要自动去建仓库或改推别处 |
| **推送要凭证且失败** | 停止，报告原始错误；不要试图改 remote URL 绕过 |

---

## 5. 一个完整的例子

假设工作区有：`packages/shared/src/protocol.ts`（加了字段）、
`packages/core/src/aggregate.ts`（修了时区 bug）、
`packages/core/test/core.test.ts`（补了断言）、`README.md`（改了说明）。

```bash
# 功能点 1：契约新增字段
git add packages/shared/src/protocol.ts
git diff --cached --stat      # 只有 1 个文件 ✓
git commit -m "feat(shared): 上报 DTO 新增 cacheWrite 字段"
git push origin HEAD

# 功能点 2：修时区 bug（测试是它的防线，合并成一条；
#            若本仓约定测试单独提交，则拆成两条）
git add packages/core/src/aggregate.ts packages/core/test/core.test.ts
git diff --cached --stat      # 只有 core 的 2 个文件 ✓
git commit -m "fix(core): 时间分桶改在 JS 侧做，避免测试环境时区偏移"
git push origin HEAD

# 功能点 3：文档
git add README.md
git diff --cached              # 确认没有夹带代码 ✓
git commit -m "docs: 补充拆分提交的约定说明"
git push origin HEAD

git status --short             # 应变干净
```

**注意功能点 2 的分组逻辑**：测试和它保护的代码放一起，是因为
**去掉测试，这个 fix 就没有防线了** —— 符合第 2 步的「去掉它还成立吗」。
但如果本仓约定「测试单独提交」，就跟随本仓约定。

---

## 6. 与本仓其他 skill 的关系

| 主题 | 去哪 |
|---|---|
| 提交前要不要跑测试 / typecheck | `repo-conventions` §7（`bun test && bun run typecheck`） |
| 中文注释与提交风格 | `repo-conventions` §6 |
| 命令与包管理器（`bun`，不是 npm） | `repo-conventions` §1 |

> ⚠️ **本 skill 不做代码质量把关**。如果改动明显会让 `bun test` 变红，
> 在收尾报告里**提醒**用户，但不要因此拒绝提交 ——
> 用户的授权是「提交推送」，不是「顺便修好」。
> 需要把关时，那是 `repo-conventions` §7 的职责，不是这里。