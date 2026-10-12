/** 默认报表技能目录由前后端共用；技能选择不改变当前用户的数据权限。 */
export const ASSISTANT_SKILLS = [
  { id: 'report', command: '/report', title: '管理报表', description: '按时间和维度整理用量、趋势、分布与管理建议', prompt: '生成最近7天的管理报表，包含用量总览、日趋势、人员、项目和模型分布，导出 HTML 报告。' },
  { id: 'weekly', command: '/weekly', title: '管理周报', description: '回顾完整上周，定位用量变化与需要跟进的问题', prompt: '生成上周的管理周报，包含用量总览、日趋势、人员、项目和来源分布，导出 HTML 报告。' },
  { id: 'monthly', command: '/monthly', title: '管理月报', description: '回顾完整上月，支持团队和项目资源复盘', prompt: '生成上月的管理月报，包含用量总览、日趋势、分组、项目和模型分布，导出 HTML 报告。' },
  { id: 'cost', command: '/cost', title: '费用分析', description: '查看费用估算、模型选择与未计价限制', prompt: '生成上月的费用分析报表，按供应商、模型和项目查看费用估算与用量，说明未计价和多币种限制，导出 HTML 报告。' },
  { id: 'adoption', command: '/adoption', title: '使用分布', description: '了解人员、分组和客户端来源的使用情况', prompt: '生成最近30天的使用分布报表，按人员、分组和来源展示用量，不用 Token 数判断人员绩效，导出 HTML 报告。' },
  { id: 'cache', command: '/cache', title: '缓存分析', description: '按模型、供应商和来源检查缓存表现', prompt: '生成最近7天的缓存分析报表，按模型、供应商和来源展示缓存读写与命中率，区分观察和待验证建议，导出 HTML 报告。' },
  { id: 'quality', command: '/quality', title: '数据质量', description: '核对已入库来源、归属与报表可信度限制', prompt: '生成最近7天的数据质量报表，包含采集诊断和来源分布，说明归属、静默来源与覆盖率的证据边界，导出 HTML 报告。' },
] as const

export type AssistantSkill = typeof ASSISTANT_SKILLS[number]
export type AssistantSkillId = AssistantSkill['id']
