/**
 * 自定义技能目录：成员保存的「命令 + 默认请求草稿」，可额外带一段脚本。
 *
 * ★ 存储与对话同级（`<数据目录>/assistant/.skills/`）：私有技能一人一份 JSON，
 *   公开技能全区一份。它**不进上报库** —— 这里没有用量事实，也不是身份或权限，
 *   加一张表就要连带一个 schema 版本、迁移与两套后端对账，收益只是把同一份
 *   JSON 换个地方放。
 * ⚠️ 一次部署只有一个进程写这份目录（与对话、导出文件同前提前提）。跨进程并发写
 *   没有分布式锁：原子替换能保证「不会读到半个文件」，但两个进程同时创建同名技能时
 *   后者会覆盖前者。多实例部署前必须先解决这一点。
 * ★ 归属只认服务端身份（`owner_member_id`），浏览器提交不了创建者。
 * ★ 技能不携带任何权限：调用时仍按当前身份重新鉴权、重新决定数据范围。
 * ★ 脚本**只在这里存与校验**（含保存时语法检查），执行在 `skill-script.ts` 的沙箱里，
 *   而且只有「用户本轮明确调用了这条技能」时才执行 —— 目录层不跑任何成员代码。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import {
  ASSISTANT_CUSTOM_SKILL_LIMITS, assistantSkillCommandReserved, assistantSkillCommandValid,
  type AssistantCustomSkill, type AssistantCustomSkillInput, type AssistantCustomSkillVisibility, type AssistantSkillCatalog,
} from '@ai-token-report/shared'
import type { Principal } from '../identity/types.js'
import { IdentityError } from '../identity/types.js'
import { replaceAssistantFile } from './atomic-file.js'
import { assertSkillScriptSyntax } from './skill-script.js'

/** 磁盘上的记录：比对外契约多一个权威归属，永远不整个发给浏览器。 */
export interface StoredCustomSkill {
  skill_id: string
  command: string
  title: string
  description: string
  prompt: string
  /** 可选脚本源码；没有脚本的技能与从前完全一样。 */
  script?: string
  visibility: AssistantCustomSkillVisibility
  owner_member_id: string
  owner_name: string
  created_at_ms: number
  updated_at_ms: number
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const control = /[\r\n\t\u0000-\u001f]/
const visibilityValues: AssistantCustomSkillVisibility[] = ['private', 'public']
/** 写操作串行化的唯一键。读不加锁：原子替换保证读到的要么是旧文件、要么是新文件。 */
const WRITE_LOCK = 'catalog'

/** 管理员可以清理公开技能（创建者离职后不会留下一份删不掉的全员内容）。 */
function isAdmin(principal: Principal): boolean { return principal.roleCodes.includes('admin') }

export class AssistantSkillStore {
  private queues = new Map<string, Promise<unknown>>()
  constructor(private root: string, private now: () => number = Date.now) {}

  private directory(): string { return join(this.root, '.skills') }
  private publicPath(): string { return join(this.directory(), 'public.json') }
  private memberPath(memberId: string): string {
    // ★ 目录名用身份哈希：改名或重命名人员不会改变技能归属。
    return join(this.directory(), 'members', `${createHash('sha256').update(memberId).digest('hex')}.json`)
  }

  /**
   * 写序列化。
   *
   * ⚠️ 键是**全局**的，不是「每个文件一把」：创建与删除各自读两个文件再写其中一个，
   *   按文件分锁时，「创建公开技能」与「删除私有技能」会各自基于旧快照落盘，
   *   表现为被删的技能又回来了（或者两个同名命令同时通过查重）。
   */
  private async withWriteLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(WRITE_LOCK) ?? Promise.resolve()
    let unlock!: () => void
    const current = new Promise<void>(done => { unlock = done })
    this.queues.set(WRITE_LOCK, current)
    await previous.catch(() => {})
    try { return await work() }
    finally {
      unlock()
      if (this.queues.get(WRITE_LOCK) === current) this.queues.delete(WRITE_LOCK)
    }
  }

  private async read(path: string): Promise<StoredCustomSkill[]> {
    let raw: string
    try { raw = await readFile(path, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    let parsed: unknown
    try { parsed = JSON.parse(raw) }
    catch { throw new IdentityError(503, '技能目录文件解析失败，请管理员检查数据目录') }
    const skills = (parsed as { version?: unknown; skills?: unknown })?.version === 1 ? (parsed as { skills: unknown }).skills : undefined
    if (!Array.isArray(skills)) throw new IdentityError(503, '技能目录文件格式不兼容，请管理员检查数据目录')
    // ★ 坏记录**明确失败**而不是静默丢掉：少一条技能看起来就像「我建的技能没了」。
    return skills.map(entry => this.record(entry))
  }

  private record(entry: unknown): StoredCustomSkill {
    const fail = () => new IdentityError(503, '技能目录包含无效记录，请管理员检查数据目录')
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw fail()
    const value = entry as Record<string, unknown>
    const text = (key: string, limit: number): string => {
      const item = value[key]
      if (typeof item !== 'string' || !item.trim() || item.length > limit) throw fail()
      return item
    }
    const stored: StoredCustomSkill = {
      skill_id: text('skill_id', 64), command: text('command', ASSISTANT_CUSTOM_SKILL_LIMITS.command_chars),
      title: text('title', ASSISTANT_CUSTOM_SKILL_LIMITS.title_chars), description: text('description', ASSISTANT_CUSTOM_SKILL_LIMITS.description_chars),
      prompt: text('prompt', ASSISTANT_CUSTOM_SKILL_LIMITS.prompt_chars), owner_member_id: text('owner_member_id', 64), owner_name: text('owner_name', 64),
      visibility: value.visibility as AssistantCustomSkillVisibility, created_at_ms: Number(value.created_at_ms), updated_at_ms: Number(value.updated_at_ms),
      // ★ 没有脚本的技能与从前完全一样：旧目录文件不需要迁移，脚本也不会被补成空串。
      ...(value.script === undefined ? {} : { script: text('script', ASSISTANT_CUSTOM_SKILL_LIMITS.script_chars) }),
    }
    if (!uuid.test(stored.skill_id) || !assistantSkillCommandValid(stored.command) || !visibilityValues.includes(stored.visibility)
      || !Number.isSafeInteger(stored.created_at_ms) || !Number.isSafeInteger(stored.updated_at_ms)) throw fail()
    return stored
  }

  private async write(path: string, skills: StoredCustomSkill[]): Promise<void> {
    if (!resolve(path).startsWith(resolve(this.root) + sep)) throw new Error('技能目录超出配置根')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = join(dirname(path), `${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify({ version: 1, skills }), { mode: 0o600 })
    await replaceAssistantFile(temporary, path)
  }

  private sort(skills: StoredCustomSkill[]): StoredCustomSkill[] {
    return [...skills].sort((a, b) => b.updated_at_ms - a.updated_at_ms || (a.command < b.command ? -1 : a.command > b.command ? 1 : 0))
  }

  /**
   * 当前身份可见的技能：自己的私有技能 + 全部公开技能。
   * ★ 私有在前：同名时私有技能胜出（自己保存的命令永远盖得住全区的）。
   */
  async snapshot(memberId: string): Promise<StoredCustomSkill[]> {
    const [mine, shared] = await Promise.all([this.read(this.memberPath(memberId)), this.read(this.publicPath())])
    return [...this.sort(mine.filter(skill => skill.visibility === 'private')), ...this.sort(shared.filter(skill => skill.visibility === 'public'))]
  }

  /** 对外目录：过滤掉别人的私有技能，并按查看者决定是否暴露创建者姓名。 */
  async list(principal: Principal): Promise<AssistantSkillCatalog> {
    const visible = await this.snapshot(principal.memberId)
    const admin = isAdmin(principal)
    return {
      skills: visible.map(skill => this.wire(skill, principal.memberId, admin)),
      private_limit: ASSISTANT_CUSTOM_SKILL_LIMITS.private_per_member,
      public_limit: ASSISTANT_CUSTOM_SKILL_LIMITS.public_total,
    }
  }

  private wire(skill: StoredCustomSkill, memberId: string, admin: boolean): AssistantCustomSkill {
    const mine = skill.owner_member_id === memberId
    return {
      skill_id: skill.skill_id, command: skill.command, title: skill.title, description: skill.description, prompt: skill.prompt,
      // ★ 能运行这条脚本的人就应该能读到它：公开技能隐藏代码、却允许任何人执行，才是更糟的形态。
      ...(skill.script ? { script: skill.script } : {}),
      visibility: skill.visibility, mine,
      can_delete: mine || (admin && skill.visibility === 'public'),
      // ★ 创建者姓名只给本人与管理员：公开技能已经发给全体，但「谁建的」不是全体都要知道的名字。
      ...(mine || admin ? { owner_name: skill.owner_name } : {}),
      created_at_ms: skill.created_at_ms, updated_at_ms: skill.updated_at_ms,
    }
  }

  async create(principal: Principal, input: unknown): Promise<AssistantCustomSkill> {
    const { command, title, description, prompt, script, visibility } = this.validate(input)
    return await this.withWriteLock(async () => {
      const [mine, shared] = await Promise.all([this.read(this.memberPath(principal.memberId)), this.read(this.publicPath())])
      const myPrivate = mine.filter(skill => skill.visibility === 'private')
      const publicSkills = shared.filter(skill => skill.visibility === 'public')
      // ★ 两条上限各自独立：私有额度满了不该连带禁止保存公开技能（反之亦然）。
      if (visibility === 'private' && myPrivate.length >= ASSISTANT_CUSTOM_SKILL_LIMITS.private_per_member) throw new IdentityError(409, `私有技能最多 ${ASSISTANT_CUSTOM_SKILL_LIMITS.private_per_member} 个，请先删除不用的`)
      // ★ 只和「当前身份看得见的名字」查重：别人的私有命令我本来就看不到。
      const taken = [...myPrivate, ...publicSkills].find(skill => skill.command === command)
      if (taken) throw new IdentityError(409, `命令 ${command} 已被${taken.visibility === 'public' ? '一个公开技能' : '你的另一个技能'}占用，请换一个`)
      if (visibility === 'public' && publicSkills.length >= ASSISTANT_CUSTOM_SKILL_LIMITS.public_total) throw new IdentityError(409, `公开技能最多 ${ASSISTANT_CUSTOM_SKILL_LIMITS.public_total} 个，请联系管理员清理`)
      const timestamp = this.now()
      const record: StoredCustomSkill = {
        skill_id: randomUUID(), command, title, description, prompt, visibility,
        ...(script ? { script } : {}),
        owner_member_id: principal.memberId, owner_name: principal.name, created_at_ms: timestamp, updated_at_ms: timestamp,
      }
      if (visibility === 'public') await this.write(this.publicPath(), [...publicSkills, record])
      else await this.write(this.memberPath(principal.memberId), [...myPrivate, record])
      return this.wire(record, principal.memberId, isAdmin(principal))
    })
  }

  /** 删除：创建者删自己的；管理员额外可以清理公开技能（别人的私有技能任何人都不动）。 */
  async remove(principal: Principal, skillId: string): Promise<void> {
    if (typeof skillId !== 'string' || !uuid.test(skillId)) throw new IdentityError(400, '技能 ID 无效')
    await this.withWriteLock(async () => {
      const memberPath = this.memberPath(principal.memberId)
      const mine = await this.read(memberPath)
      if (mine.some(skill => skill.skill_id === skillId)) {
        await this.write(memberPath, mine.filter(skill => skill.skill_id !== skillId))
        return
      }
      const shared = await this.read(this.publicPath())
      const target = shared.find(skill => skill.skill_id === skillId)
      if (!target) throw new IdentityError(404, '技能不存在或不属于当前用户')
      if (target.owner_member_id !== principal.memberId && !isAdmin(principal)) throw new IdentityError(403, '只有创建者或管理员可以删除这个公开技能')
      await this.write(this.publicPath(), shared.filter(skill => skill.skill_id !== skillId))
    })
  }

  private validate(input: unknown): AssistantCustomSkillInput {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new IdentityError(400, '创建技能需要提供命令、标题、说明、指令与可见范围')
    const value = input as Record<string, unknown>
    const keys = ['command', 'title', 'description', 'prompt', 'visibility']
    if (Object.keys(value).some(key => !keys.includes(key) && key !== 'script') || keys.some(key => value[key] === undefined)) throw new IdentityError(400, '创建技能需要提供命令、标题、说明、指令与可见范围')
    const text = (key: string, limit: number, label: string, multiline = false): string => {
      const item = value[key]
      if (typeof item !== 'string') throw new IdentityError(400, `${label}需要是文本`)
      const trimmed = item.trim()
      if (!trimmed || trimmed.length > limit || (!multiline && control.test(trimmed))) throw new IdentityError(400, `${label}需要为 1～${limit} 个字符${multiline ? '' : '，且不能包含换行或制表符'}`)
      return trimmed
    }
    // ★ 命令统一小写后入库：解析与查重都按小写比较，库里留着两种写法就会出现「看起来重名却没拦住」。
    const command = typeof value.command === 'string' ? value.command.trim().toLocaleLowerCase() : ''
    if (!assistantSkillCommandValid(command)) throw new IdentityError(400, '命令需要形如 /weekly-cost，以字母开头，只用小写字母、数字和连字符')
    if (assistantSkillCommandReserved(command)) throw new IdentityError(409, `命令 ${command} 已被平台内置技能占用，请换一个`)
    const title = text('title', ASSISTANT_CUSTOM_SKILL_LIMITS.title_chars, '技能标题')
    const description = text('description', ASSISTANT_CUSTOM_SKILL_LIMITS.description_chars, '技能说明')
    const prompt = text('prompt', ASSISTANT_CUSTOM_SKILL_LIMITS.prompt_chars, '指令草稿', true)
    // ★ 脚本在**写入之前**做语法检查：存一条永远跑不起来的脚本，用户要到调用时才发现。
    const script = value.script === undefined ? undefined : (() => {
      if (typeof value.script !== 'string') throw new IdentityError(400, '技能脚本需要是文本')
      const trimmed = value.script.trim()
      if (!trimmed || trimmed.length > ASSISTANT_CUSTOM_SKILL_LIMITS.script_chars || trimmed.includes('\u0000')) throw new IdentityError(400, `技能脚本需要为 1～${ASSISTANT_CUSTOM_SKILL_LIMITS.script_chars} 个字符`)
      assertSkillScriptSyntax(trimmed)
      return trimmed
    })()
    const visibility = value.visibility as AssistantCustomSkillVisibility
    if (!visibilityValues.includes(visibility)) throw new IdentityError(400, '可见范围只能是仅自己或所有人')
    return { command, title, description, prompt, ...(script ? { script } : {}), visibility }
  }
}