/** 用户私有助手目录。仅接受服务端身份与 UUID，删除同时移除 DSH 日志与页面记录。 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { AssistantDetail, AssistantSession } from '@ai-token-report/shared'
import { IdentityError } from '../identity/types.js'

export class AssistantStore {
  constructor(readonly root: string, readonly retentionDays = 30) {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) throw new Error('助手保留期需要为 1～365 天')
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
  async list(memberId: string): Promise<AssistantSession[]> {
    let ids: string[]
    try { ids = await readdir(this.userPath(memberId)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const sessions: AssistantSession[] = []
    for (const id of ids) {
      let detail: AssistantDetail
      try { detail = await this.get(memberId, id) }
      catch (err) { if (err instanceof IdentityError && err.status === 404) continue; throw err }
      if (detail.session.updated_at_ms < Date.now() - this.retentionDays * 86_400_000) {
        await this.delete(memberId, id)
      } else sessions.push(detail.session)
    }
    return sessions.sort((a, b) => b.updated_at_ms - a.updated_at_ms)
  }
  async get(memberId: string, id: string): Promise<AssistantDetail> {
    try { return JSON.parse(await readFile(join(this.sessionPath(memberId, id), 'conversation.json'), 'utf8')) as AssistantDetail }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new IdentityError(404, '会话不存在或不属于当前用户')
      throw error
    }
  }
  async create(memberId: string): Promise<AssistantDetail> {
    if ((await this.list(memberId)).length >= 100) throw new IdentityError(409, '会话已达 100 个，请先删除旧会话')
    const now = Date.now()
    const detail: AssistantDetail = { session: {
      session_id: randomUUID(), title: '新对话', created_at_ms: now, updated_at_ms: now, turn_count: 0,
    }, messages: [] }
    await this.save(memberId, detail)
    return detail
  }
  async save(memberId: string, detail: AssistantDetail): Promise<void> {
    const dir = this.sessionPath(memberId, detail.session.session_id)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const temporary = join(dir, `${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(detail), { mode: 0o600 })
    await rename(temporary, join(dir, 'conversation.json'))
  }
  async delete(memberId: string, id: string): Promise<void> {
    await this.get(memberId, id)
    // ★ 路径始终为固定根 / 身份哈希 / UUID，不允许客户端指定 DSH 日志根。
    await rm(this.sessionPath(memberId, id), { recursive: true, force: true })
  }
  async prune(excludedMembers: ReadonlySet<string>): Promise<void> {
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
