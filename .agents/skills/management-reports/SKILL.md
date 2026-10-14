---
name: management-reports
description: Create or extend manager-facing Token usage reports in ai-token-report, including weekly/monthly reviews, cost, adoption, cache and data-quality analysis, and the portal assistant's default slash skills.
---

# 管理报表

使用部门看板 AI 助手的默认报表能力，或维护它的工具与技能。先读 [管理报表与默认技能](../../../docs/管理报表与默认技能.md)，明确决策问题、时间、授权范围和证据边界。

## 生成报告

在已登录的部门 AI 助手中使用 `/report`、`/weekly`、`/monthly`、`/cost`、`/adoption`、`/cache` 或 `/quality`，选择只填草稿，发送才执行。用户自然语言也可调用同一能力；用户明确条件优先于模板。没有指定条件时采用目录中的默认周期与维度，周报为完整上周、月报为完整上月。

实际数据必须来自当前身份授权的统计查询。复用 `generate_management_report` 或已查询的会话数据集；文件使用 `dataset_ids` 多节导出。没有可访问的运行实例或授权数据时，可以整理需求与模板，不能把样本报表当真实业务报告。

报告给出实际窗口、授权范围、各节采集时刻、真实数字与限制。先写可验证的发现，再给行动建议与验证方法。比较注明实际基准，未定义的增长率不心算。多个独立分布章节不可相加，分组为多对多。无数据只代表本窗口没有已入库记录。

Token 规模不能评价人员绩效、质量或 ROI；缺预算、应采名单、任务产出等基准时说明尚不能回答。未计价是未知，币种分别展示，费用是单价估算；无金额权限只给用量。低缓存率和峰值只当线索。诊断结构性恒值不能包装成逐条校验通过，最近用量时间不能写成最近上报时间。

生成报告不隐含公开分享、管理配置修改、消息发送或定时任务。按用户明确请求沿用平台既有入口处理这些动作。

## 自定义技能

技能**由对话生成，没有手填表单**。`/create-skill`（或菜单里的「新建技能」）由浏览器直接处理、**不进对话**：它只把一段模板（名称 / 用途 / 输出 / 数据处理方式）填进输入框，用户补完按 Enter，助手调用 `create_skill` 生成并保存 `/命令` + 标题 + 说明 + 草稿（可选脚本）。`/skills`（菜单里的「管理技能」）打开技能列表，只做查看与删除。可见范围**默认仅自己**：只有用户本轮自己说出「所有人可见 / 部门共享」，`create_skill` 才允许保存公开技能（`assistantPublicSkillIntent()`），否则回 403 —— 模型不能替用户公开。契约在 `packages/shared/src/assistant-skills.ts`（`ASSISTANT_SKILL_ACTIONS` + `AssistantCustomSkill` + 校验/上限 + `ASSISTANT_SKILL_SCRIPT_LIMITS`），存储在 `packages/server/src/assistant/skill-store.ts`，解析与指引在 `assistant/skills.ts`，授权意图在 `assistant/intents.ts`，两个工具在 `assistant/runtime.ts`，脚本沙箱在 `assistant/skill-script.ts`，HTTP 在 `assistant-route.ts`，技能列表在 `web-portal/src/components/AssistantSkillForm.vue`。

三条不可退让的边界：①**技能草稿不是授权** —— `resolveAssistantSkill()` 的 `intent` 只取用户本轮自己敲的正文，公开技能保存「删除项目规则」也不能替调用者挂载写入或分享工具；②**技能不改变数据范围** —— 每次调用重新鉴权、重新定金额与人员范围，公开技能不会让任何人多看见一行数据；③**模型不能注入代码** —— `run_skill_script` 只执行「用户本轮明确调用的那条技能」保存时经语法校验的脚本（`skillRequest.custom?.script`），对话里新写的代码进不来。创建者姓名只给本人与管理员；私有技能对他人不可见、管理员也不能删。上限每人 50 条私有、全区 100 条公开；命令统一小写、与内置命令同名即拒绝。技能目录在 `<dataDir>/assistant/.skills/`，**不进上报库**，只备份数据库不包含它。

脚本是**同步函数体**（`return` 可序列化结果，数据从 `input` 读），在 `node:vm` + `Object.create(null)` 上下文里执行：数据以 JSON 字面量注入、结果以 JSON 取回，没有宿主对象跨界，没有网络 / 文件 / 进程 / 定时器 / `require`，`eval` 与 `Function` 关闭，超时 1,500 毫秒、输入 32,000 字符、输出 64,000 字符、脚本 4,000 字符。⚠️ `vm` 不是安全沙箱 —— 目标是「纯数据变换」，脚本来源是用户自己或部门内可见的技能，因此**脚本对能运行它的人可见**（目录会把 `script` 一起下发）。结果带 `computed_by_skill_script: true` 与说明，引用时必须写明**「脚本计算，非平台口径」**，不得当作平台用量、金额或绩效结论，也不得替换查询接口的真实数值。

## 维护能力

默认目录唯一真源为 `packages/shared/src/assistant-skills.ts`，产品指引在 `packages/server/src/assistant/skills.ts`，确定性工具在 `assistant/reports.ts`。本文件是仓库中的复用工作说明；线上助手通过服务端注册默认能力，不会从开发者本机的 Codex 技能目录动态加载。

复用统计路由的实时鉴权、数据范围、归一化和金额计算，不绕过路由直接查业务库。日期由后端解析，一份报表共享冻结时间边界，但各节仍是独立读取快照。保留完整返回行与模型预览的区别、分页、截断、来源与失败语义；任何一节失败时不创建部分完整报表。

根据改动运行 server 的 assistant-skills/reports/artifacts/usage/presentation 相关测试与真实 DSH 回环装载验证；自定义技能另跑 `bun test packages/server/test/assistant-skill-store.test.ts packages/server/test/assistant-skill-route.test.ts packages/server/test/assistant-skill-script.test.ts`、`bun test packages/web-portal/test/assistant-skills.test.ts`，以及真 DSH 内核的 `bun run packages/server/verify/verify-assistant-runtime.ts <协议> --skills`（三种协议各跑一次：建技能、公开护栏、脚本沙箱执行、提问轮不挂载写入面）。前端菜单运行 web-portal 的 assistant-skills/composer/conversations 测试和 SSR 验证（弹框主体拆成 `AssistantSkillForm.vue` 才能被 SSR 执行）。完成全仓类型检查与两个 Web 构建。模型理解的真实验收按 `docs/AI助手用例与验收.md` 的隔离流程进行，不把回环夹具宣称为真实模型验证。
