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

## 维护能力

默认目录唯一真源为 `packages/shared/src/assistant-skills.ts`，产品指引在 `packages/server/src/assistant/skills.ts`，确定性工具在 `assistant/reports.ts`。本文件是仓库中的复用工作说明；线上助手通过服务端注册默认能力，不会从开发者本机的 Codex 技能目录动态加载。

复用统计路由的实时鉴权、数据范围、归一化和金额计算，不绕过路由直接查业务库。日期由后端解析，一份报表共享冻结时间边界，但各节仍是独立读取快照。保留完整返回行与模型预览的区别、分页、截断、来源与失败语义；任何一节失败时不创建部分完整报表。

根据改动运行 server 的 assistant-skills/reports/artifacts/usage/presentation 相关测试与真实 DSH 回环装载验证；前端菜单运行 web-portal 的 assistant-skills/composer/conversations 测试和 SSR 验证。完成全仓类型检查与两个 Web 构建。模型理解的真实验收按 `docs/AI助手用例与验收.md` 的隔离流程进行，不把回环夹具宣称为真实模型验证。
