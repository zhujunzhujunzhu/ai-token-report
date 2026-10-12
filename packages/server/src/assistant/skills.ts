/** 技能只加载服务端维护的指引，输入里的正文与附件不能改写技能或扩大权限。 */
import { ASSISTANT_SKILLS, type AssistantSkill } from '@ai-token-report/shared'
import { IdentityError } from '../identity/types.js'

export function resolveAssistantSkill(prompt: string): { skill?: AssistantSkill; request: string } {
  const trimmed = prompt.trim()
  const command = /^\/([a-z][a-z0-9-]*)(?=\s|$)/i.exec(trimmed)
  if (!command) return { request: trimmed }
  const skill = ASSISTANT_SKILLS.find(item => item.command === command[0].toLowerCase())
  if (!skill) throw new IdentityError(400, '这个技能不存在，请输入 / 选择默认报表技能')
  return { skill, request: trimmed.slice(command[0].length).trim() || skill.prompt }
}

export function assistantReportGuidance(prompt: string): string {
  const { skill } = resolveAssistantSkill(prompt)
  return `\n管理报表能力：用户要求报表、周报、月报、费用分析、使用分布、缓存分析或数据质量报告时，优先调用 generate_management_report，一次取得同一时间窗的授权数据并生成包含多节真实数据的私有文件。普通单指标提问继续 query_usage。${skill ? `本轮用户明确选择技能 ${skill.command}（${skill.title}），调用 generate_management_report 时 preset="${skill.id}"。` : ''}
具名技能提供默认时间与维度，用户明确指定的时间、人员、分组、供应商、模型、来源、维度和格式优先于默认。只给命令时直接使用该技能默认参数；用户给了额外条件时准确传入工具，不用默认覆盖。报表的 period/from_date/to_date 与比较基准遵循工具契约；比较只引用两期实际窗口与原值，没有基准就不给增长率。工具失败、同名、未找到或无权限时停止并说明，不生成部分报表充当完整结果。
管理报表回答可比普通查数更完整：先给有证据的发现，再给需要跟进的事项及验证方法，并注明实际时间、当前授权范围、数据来源和限制。已展示表格不用逐行复述。文件卡出现后才能声称报告已生成。导出统计使用服务端数据集，多个章节用 dataset_ids，不把模型编写的统计数字放进 content；生成文件不自动分享，也不写管理配置。
Token 和调用量是使用规模，不能直接评价人员绩效、代码质量或业务产出；没有全员应采名单就不能计算采用率或采集覆盖率；没有预算、账单、质量和产出数据就不能声称超预算、实际账单、ROI 或模型性价比。低缓存命中率与用量峰值仅是线索，不能推断根因。费用按已配置单价估算，未计价为未知，各币种分别保留；没有 cost:read 时报告只含用量并说明权限限制。分组为多对多，各组不能相加当部门总量或计算饼图份额。无数据只表示当前窗口没有已入库用量，不能断言没有使用。采集诊断中 identityViolations 是结构性值，不能包装成逐条校验通过；最近用量时间也不是最近上报时间。`
}
