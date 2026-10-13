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

/**
 * 斜杠菜单里的**动作**条目。
 *
 * ★ 与 `ASSISTANT_SKILLS` 刻意分成两份：默认报表技能的 `prompt` 是
 *   **服务端维护的默认请求**，只给命令时会用它去调用模型；而 `/create-skill`
 *   由浏览器直接打开「新建技能」表单，**从不进入对话**，也不该被
 *   `resolveAssistantSkill()` 当成一个可执行技能（它没有可信的默认请求）。
 *   合成一份的结果是：有人手动把 `/create-skill` 发出去，服务端会拿一段
 *   表单说明去问模型 —— 看起来「技能没生效」，实际是问错了对象。
 */
export const ASSISTANT_SKILL_ACTIONS = [
  { command: '/create-skill', title: '新建技能', description: '把常用问法保存成 / 命令，选择仅自己或所有人可见' },
] as const

export type AssistantSkillAction = typeof ASSISTANT_SKILL_ACTIONS[number]

/** 自定义技能的可见范围：仅创建者本人，或部门内所有成员。 */
export type AssistantCustomSkillVisibility = 'private' | 'public'

/**
 * 自定义技能：成员保存的「命令 + 默认请求草稿」。
 *
 * ★ 它**不携带任何权限**：调用时仍旧按当前身份重新鉴权、重新定数据范围，
 *   公开技能不会让任何人多看见一行数据。
 * ★ 归属只由服务端身份写死（浏览器给不出别的创建者）。
 */
export interface AssistantCustomSkill {
  skill_id: string
  command: string
  title: string
  description: string
  prompt: string
  visibility: AssistantCustomSkillVisibility
  /** 创建时刻的姓名快照；只有本人与管理员会收到，其他人看不到创建者是谁。 */
  owner_name?: string
  /** 当前登录者是不是创建者。 */
  mine: boolean
  /** 能否删除由服务端判定（创建者，或管理员删公开技能），不在页面里推算。 */
  can_delete: boolean
  created_at_ms: number
  updated_at_ms: number
}

/** 技能目录响应：自定义技能 + 当前复用的两条上限（页面据此提示剩余额度）。 */
export interface AssistantSkillCatalog {
  skills: AssistantCustomSkill[]
  private_limit: number
  public_limit: number
}

/** 创建技能请求体；字段与页面表单一一对应，服务端仍逐项校验。 */
export interface AssistantCustomSkillInput {
  command: string
  title: string
  description: string
  prompt: string
  visibility: AssistantCustomSkillVisibility
}

/**
 * 创建限制：服务端与页面共用同一份数字。
 *
 * ⚠️ 页面用它做即时提示，服务端用它做**唯一**的准入判定；
 *    两份数字漂移的表现是「表单说可以，保存却报错」或「超长内容写进磁盘」。
 */
export const ASSISTANT_CUSTOM_SKILL_LIMITS = {
  command_chars: 32,
  title_chars: 24,
  description_chars: 80,
  prompt_chars: 1000,
  private_per_member: 50,
  public_total: 100,
} as const

/**
 * 自定义命令格式（kebab-case，与斜杠命令解析同一套语法）。
 *
 * ★ 只允许小写：解析与匹配都走小写，允许大写会让「同一个命令」出现两种写法。
 */
export function assistantSkillCommandValid(command: string): boolean {
  return command.length <= ASSISTANT_CUSTOM_SKILL_LIMITS.command_chars && /^\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(command)
}

/** 内置技能与动作条目占用的命令不允许被自定义技能覆盖。 */
export function assistantSkillCommandReserved(command: string): boolean {
  const normalized = command.toLocaleLowerCase()
  return ASSISTANT_SKILLS.some(skill => skill.command === normalized) || ASSISTANT_SKILL_ACTIONS.some(action => action.command === normalized)
}