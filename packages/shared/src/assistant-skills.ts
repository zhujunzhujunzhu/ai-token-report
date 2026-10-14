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
 *   **服务端维护的默认请求**，只给命令时会用它去调用模型；而这两条动作
 *   由浏览器直接处理，**从不进入对话**，也不该被 `resolveAssistantSkill()`
 *   当成可执行技能（它们没有可信的默认请求）。合成一份的结果是：有人手动把
 *   `/create-skill` 发出去，服务端会拿一段模板去问模型 —— 看起来「技能没生效」，
 *   实际是问错了对象。
 * ★ `prompt` 有值 = 选中后把这段模板填进输入框（用户接着改名、写用途再发送）；
 *   空串 = 由页面打开技能管理弹框。两种行为都在浏览器本地完成。
 */
export const ASSISTANT_SKILL_ACTIONS = [
  {
    command: '/create-skill',
    title: '新建技能',
    description: '说清楚名称和用途，助手直接生成并保存；需要处理数据时可以带脚本',
    prompt: '帮我新建一个技能。\n名称：\n用途：\n希望它输出什么：\n需要处理数据的方式（可选）：',
    badge: '对话生成',
  },
  { command: '/skills', title: '管理技能', description: '查看已保存的命令与脚本，删除不用的技能', prompt: '', badge: '打开列表' },
] as const

export type AssistantSkillAction = typeof ASSISTANT_SKILL_ACTIONS[number]

/** 自定义技能的可见范围：仅创建者本人，或部门内所有成员。 */
export type AssistantCustomSkillVisibility = 'private' | 'public'

/**
 * 自定义技能：成员保存的「命令 + 默认请求草稿」，可额外带一段脚本。
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
  /**
   * 技能携带的脚本（可选）。
   *
   * ★ 可见技能就下发脚本本身：能运行它的人本来就应该能读到它 ——
   *   部门共享的脚本隐藏代码、却允许任何人执行，才是更糟的形态。
   */
  script?: string
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

/**
 * 创建技能请求体。
 *
 * ★ 页面不再有「新建技能」表单：这份字段由助手在对话里生成，经 `create_skill`
 *   工具落到服务端；服务端仍逐项校验（谁调用都一样，工具不是绕过校验的旁路）。
 */
export interface AssistantCustomSkillInput {
  command: string
  title: string
  description: string
  prompt: string
  /** 可选的脚本源码：同步执行、用 `return` 返回结果、通过 `input` 读取数据。 */
  script?: string
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
  /** 技能脚本源码上限；脚本由创建者写、由沙箱执行，不是任意长度的程序仓库。 */
  script_chars: 4000,
  private_per_member: 50,
  public_total: 100,
} as const

/**
 * 技能脚本的沙箱限额：一次执行能吃多少数据、跑多久、吐多少结果。
 *
 * ★ 三份数字同时是**服务端强制**与**工具契约**：页面只需提示，不能自行放宽；
 *   缺了任意一条，脚本就能把一次对话变成一次资源占用（或把结果撑爆模型上下文）。
 */
export const ASSISTANT_SKILL_SCRIPT_LIMITS = {
  /** 交给脚本的输入（`input` 或数据集快照）序列化后的字符上限。 */
  input_chars: 32_000,
  /** 脚本返回值序列化后的字符上限。 */
  output_chars: 64_000,
  /** 同步执行上限：脚本必须是同步的，超时即中断本次调用。 */
  timeout_ms: 1_500,
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