/** 用户私有助手目录。仅接受服务端身份与 UUID，删除同时移除 DSH 日志与页面记录。 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { ASSISTANT_SESSION_PAGE_SIZE, type AssistantDetail, type AssistantSession, type AssistantSessionPage } from '@ai-token-report/shared'
import type { PreparedAssistantAttachment } from './attachments.js'
import { IdentityError } from '../identity/types.js'
import { replaceAssistantFile } from './atomic-file.js'
import type { Principal } from '../identity/types.js'
const accessOf = (p: Principal) => JSON.stringify([p.memberId, [...p.roleCodes ?? []].sort(), [...p.permissions].sort(), [...p.groupIds ?? []].sort()])
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const compareSessions = (a: AssistantSession, b: AssistantSession) => b.updated_at_ms - a.updated_at_ms || (a.session_id < b.session_id ? 1 : a.session_id > b.session_id ? -1 : 0)
function decodeCursor(cursor: string): { updatedAtMs: number; sessionId: string } {
  try {
    if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error()
    const buffer = Buffer.from(cursor, 'base64url')
    if (buffer.toString('base64url') !== cursor) throw new Error()
    const value: unknown = JSON.parse(buffer.toString('utf8'))
    if (!Array.isArray(value) || value.length !== 3 || value[0] !== 1 || !Number.isSafeInteger(value[1]) || value[1] < 0 || typeof value[2] !== 'string' || !sessionIdPattern.test(value[2])) throw new Error()
    return { updatedAtMs: value[1], sessionId: value[2] }
  } catch { throw new IdentityError(400, '会话分页游标无效，请刷新列表') }
}

export class AssistantStore {
  private creating = new Map<string, Promise<void>>()
  constructor(readonly root: string, readonly retentionDays: number | null = null) {
    if (retentionDays !== null && (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365)) throw new Error('助手保留期需要为 null（永久）或 1～365 天')
  }
  userPath(memberId: string): string {
    // ★ 不把姓名或客户端传来的路径写进目录名，重命名人员不会改变空间归属。
    return join(this.root, createHash('sha256').update(memberId).digest('hex'))
  }
  sessionPath(memberId: string, id: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
      throw new IdentityError(400, '会话 ID 无效')
    const target = resolve(this.userPath(memberId), id)
    if (!target.startsWith(resolve(this.root) + sep)) throw new Error('助手目录超出配置根')
    return target
  }
  async list(memberId: string, excludedSessions: ReadonlySet<string> = new Set()): Promise<AssistantSession[]> {
    let ids: string[]
    try { ids = await readdir(this.userPath(memberId)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const sessions: AssistantSession[] = []
    for (const id of ids) {
      // ★ 文件索引和分享目录不属于会话；只列出 UUID，避免生成文件后列表被索引目录阻断。
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) continue
      let detail: AssistantDetail
      try { detail = await this.get(memberId, id) }
      catch (err) { if (err instanceof IdentityError && err.status === 404) continue; throw err }
      if (this.retentionDays !== null && !excludedSessions.has(id) && detail.session.updated_at_ms < Date.now() - this.retentionDays * 86_400_000) {
        await this.delete(memberId, id)
      } else sessions.push(detail.session)
    }
    return sessions.sort(compareSessions)
  }
  async listPage(memberId: string, options: { limit?: number; cursor?: string } = {}, excludedSessions: ReadonlySet<string> = new Set()): Promise<AssistantSessionPage> {
    const limit = options.limit ?? ASSISTANT_SESSION_PAGE_SIZE
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new IdentityError(400, '每页会话数需要为 1～100')
    const boundary = options.cursor === undefined ? undefined : decodeCursor(options.cursor)
    const all = await this.list(memberId, excludedSessions)
    // ★ 用更新时间和 UUID 共同定位，插入或删除上页记录不会让下一页发生偏移。
    const remaining = boundary ? all.filter(session => session.updated_at_ms < boundary.updatedAtMs || (session.updated_at_ms === boundary.updatedAtMs && session.session_id < boundary.sessionId)) : all
    const sessions = remaining.slice(0, limit)
    const last = sessions.at(-1)
    const nextCursor = last && remaining.length > sessions.length ? Buffer.from(JSON.stringify([1, last.updated_at_ms, last.session_id])).toString('base64url') : null
    return { sessions, next_cursor: nextCursor, total: all.length }
  }
  async get(memberId: string, id: string): Promise<AssistantDetail> {
    try { return JSON.parse(await readFile(join(this.sessionPath(memberId, id), 'conversation.json'), 'utf8')) as AssistantDetail }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new IdentityError(404, '会话不存在或不属于当前用户')
      throw error
    }
  }
  async create(memberId: string, sessionId: string = randomUUID(), excludedSessions: ReadonlySet<string> = new Set()): Promise<AssistantDetail> {
    this.sessionPath(memberId, sessionId)
    const previous = this.creating.get(memberId) ?? Promise.resolve()
    let unlock!: () => void
    const current = new Promise<void>(resolve => { unlock = resolve })
    this.creating.set(memberId, current)
    // ★ 并行运行不等于并行检查会话配额；同人的目录计数和首次落盘必须串行。
    await previous
    try {
      if ((await this.list(memberId, excludedSessions)).length >= 100) throw new IdentityError(409, '会话已达 100 个，请先删除旧会话')
      const now = Date.now()
      const detail: AssistantDetail = { session: {
        session_id: sessionId, title: '新对话', created_at_ms: now, updated_at_ms: now, turn_count: 0,
      }, messages: [] }
      await this.save(memberId, detail)
      return detail
    } finally {
      unlock()
      if (this.creating.get(memberId) === current) this.creating.delete(memberId)
    }
  }
  /** ★ 历史文本和 DSH 重放也含旧权限数据，不能只给文件或新查询做撤权检查。 */
  async assertAccess(principal: Principal, id: string): Promise<void> {
    const detail = await this.get(principal.memberId, id)
    const file = join(this.sessionPath(principal.memberId, id), 'access.json')
    const access = accessOf(principal)
    try {
      const stored = JSON.parse(await readFile(file, 'utf8')) as { version: number; access: string }
      if (stored.version !== 1 || stored.access !== access) throw new IdentityError(403, '身份权限或分组已变化，旧对话不能再读取或续聊，请新建对话')
      return
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (detail.messages.length) {
      // ★ 升级旧会话只能依据所有已保存数据集的权威 scope；无凭据历史不能猜测授权。
      let entries: Array<{ access: string }>
      try { entries = (JSON.parse(await readFile(join(this.sessionPath(principal.memberId, id), 'dsh', 'datasets.json'), 'utf8')) as { datasets: Array<{ access: string }> }).datasets }
      catch { throw new IdentityError(403, '旧对话缺少可验证的数据权限，请新建对话；仍可删除旧记录') }
      if (!Array.isArray(entries) || !entries.length || entries.some(entry => entry.access !== access)) throw new IdentityError(403, '旧对话的数据权限已变化，请新建对话')
    }
    const temporary = join(this.sessionPath(principal.memberId, id), randomUUID() + '.tmp')
    await writeFile(temporary, JSON.stringify({ version: 1, access }), { mode: 0o600 })
    await replaceAssistantFile(temporary, file)
  }
  async save(memberId: string, detail: AssistantDetail): Promise<void> {
    const dir = this.sessionPath(memberId, detail.session.session_id)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const temporary = join(dir, `${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(detail), { mode: 0o600 })
    await replaceAssistantFile(temporary, join(dir, 'conversation.json'))
  }
  /** 原文件只使用服务端 UUID 落盘，用户文件名只用于展示和下载。 */
  async saveAttachments(memberId: string, id: string, attachments: PreparedAssistantAttachment[]): Promise<void> {
    if (!attachments.length) return
    await this.get(memberId, id)
    const directory = join(this.sessionPath(memberId, id), 'attachments')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const saved: string[] = []
    try {
      for (const attachment of attachments) {
        const file = this.attachmentPath(memberId, id, attachment.metadata.attachment_id)
        await writeFile(file, attachment.bytes, { mode: 0o600, flag: 'wx' })
        saved.push(file)
      }
    } catch (error) {
      await Promise.allSettled(saved.map(file => rm(file, { force: true })))
      throw error
    }
  }
  private attachmentPath(memberId: string, id: string, attachmentId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(attachmentId)) throw new IdentityError(400, '附件 ID 无效')
    return join(this.sessionPath(memberId, id), 'attachments', `${attachmentId}.bin`)
  }
  async downloadAttachment(principal: Principal, id: string, attachmentId: string): Promise<Response> {
    const file = this.attachmentPath(principal.memberId, id, attachmentId)
    await this.assertAccess(principal, id)
    const detail = await this.get(principal.memberId, id)
    const metadata = detail.messages.flatMap(message => message.attachments ?? []).find(item => item.attachment_id === attachmentId)
    if (!metadata) throw new IdentityError(404, '附件不存在或不属于当前会话')
    let bytes: Buffer
    try { bytes = await readFile(file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new IdentityError(404, '附件已不存在'); throw error }
    return new Response(bytes, { headers: {
      'Content-Type': metadata.media_type, 'Content-Length': String(bytes.length), 'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="attachment-${attachmentId}"; filename*=UTF-8''${encodeURIComponent(metadata.file_name)}`,
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; sandbox",
    } })
  }
  async delete(memberId: string, id: string): Promise<void> {
    await this.get(memberId, id)
    // ★ 路径始终为固定根 / 身份哈希 / UUID，不允许客户端指定 DSH 日志根。
    await rm(this.sessionPath(memberId, id), { recursive: true, force: true })
  }
  async prune(excludedMembers: ReadonlySet<string>): Promise<void> {
    // ★ 永久保存不扫描或删除历史；只有显式配置有限保留期才做过期清理。
    if (this.retentionDays === null) return
    const excluded = new Set([...excludedMembers].map(id => this.userPath(id)))
    let users: string[]
    try { users = await readdir(this.root) }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err }
    for (const user of users) {
      if (!/^[0-9a-f]{64}$/.test(user) || excluded.has(join(this.root, user))) continue
      const directory = join(this.root, user)
      for (const id of await readdir(directory)) {
        if (!/^[0-9a-f-]{36}$/.test(id)) continue
        const target = resolve(directory, id)
        if (!target.startsWith(resolve(this.root) + sep)) throw new Error('助手清理目录超出配置根')
        try {
          const detail = JSON.parse(await readFile(join(target, 'conversation.json'), 'utf8')) as AssistantDetail
          if (detail.session.updated_at_ms < Date.now() - this.retentionDays * 86_400_000) {
            // ★ 排除集合要在删除前再次读；清理过程中用户可能刚开始新一轮。
            if ([...excludedMembers].some(member => this.userPath(member) === directory)) continue
            await rm(target, { recursive: true, force: true })
          }
        } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err }
      }
    }
  }
}
