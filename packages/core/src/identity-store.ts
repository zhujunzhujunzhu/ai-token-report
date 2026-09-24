/**
 * 本地身份存储 —— 读写「用户主动署名」的结果。
 *
 * ## 文件位置
 *
 * ```
 * $DSH_HOME/token-report/identity.json
 * ```
 *
 * 与 DSH 自身的数据放在一起，卸载 DSH 时自然一并清理。
 *
 * ## 三条实现约束
 *
 * 1. **原子写入**：先写临时文件再 rename。直接覆写的话，进程在写一半时被杀死
 *    会留下截断的 JSON，下次启动解析失败 —— 用户会看到「我明明填过了」。
 * 2. **权限收窄**：文件含 token（身份凭证），在 POSIX 上设为 `0600`。
 *    Windows 没有对应语义，`chmod` 是 no-op，靠目录 ACL 保护。
 * 3. **解析失败不抛错**：文件损坏时当作「未署名」返回 null，让用户重新填写。
 *    抛错会让页面白屏，而此时用户恰恰最需要看到引导页。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  isSigned,
  validateIdentity,
  type Identity,
} from '@ai-token-report/shared'

/** 身份文件所在目录名。 */
const DIR_NAME = 'token-report'
/** 身份文件名。 */
const FILE_NAME = 'identity.json'

/** 解析身份文件的路径。 */
export function identityPath(dshHome: string): string {
  return join(dshHome, DIR_NAME, FILE_NAME)
}

/** 读取结果，附带「为什么没有」的信息，便于给出准确提示。 */
export interface ReadIdentityResult {
  identity: Identity | null
  /** 文件是否存在。用于区分「没填过」和「填了但文件坏了」。 */
  exists: boolean
  /** 解析失败的原因（文件损坏时才有）。 */
  error?: string
}

/**
 * 读取本地身份。
 *
 * ★ 任何异常都降级为「未署名」，**不抛错**。理由见文件头约束 3。
 */
export function readIdentity(path: string): ReadIdentityResult {
  if (!existsSync(path)) {
    return { identity: null, exists: false }
  }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    return { identity: null, exists: true, error: `读取失败: ${messageOf(err)}` }
  }

  // 空文件视为「没填过」，不视为损坏 —— 可能被外部工具截断过
  if (!raw.trim()) {
    return { identity: null, exists: true, error: '身份文件为空' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { identity: null, exists: true, error: '身份文件不是合法 JSON' }
  }

  const identity = normalize(parsed)
  if (!identity) {
    return { identity: null, exists: true, error: '身份文件字段缺失或类型不对' }
  }
  if (!isSigned(identity)) {
    // 字段在但值为空 —— 视为未署名，而不是损坏
    return { identity: null, exists: true }
  }

  return { identity, exists: true }
}

/** 把任意 JSON 值规整成 Identity，字段不对则返回 null。 */
function normalize(value: unknown): Identity | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>

  const name = typeof o['name'] === 'string' ? o['name'] : null
  const token = typeof o['token'] === 'string' ? o['token'] : null
  if (name === null || token === null) return null

  const now = Date.now()
  const createdAt = typeof o['createdAt'] === 'number' ? o['createdAt'] : now
  const updatedAt = typeof o['updatedAt'] === 'number' ? o['updatedAt'] : createdAt
  const dept = typeof o['dept'] === 'string' && o['dept'].trim() ? o['dept'].trim() : undefined

  return {
    name: name.trim(),
    token: token.trim(),
    ...(dept ? { dept } : {}),
    createdAt,
    updatedAt,
  }
}

/** 写入结果。 */
export interface WriteIdentityResult {
  ok: boolean
  reason?: string
  identity?: Identity
}

/**
 * 写入本地身份（原子）。
 *
 * 校验在此处**再跑一遍** —— 即使调用方（HTTP 路由）已经校验过。
 * 因为这是唯一落盘的地方，让它自己保证「存进去的一定合法」，
 * 比信任所有调用方更可靠。
 */
export function writeIdentity(
  path: string,
  input: { name: string; token: string; dept?: string },
): WriteIdentityResult {
  const name = input.name.trim()
  const token = input.token.trim()

  const check = validateIdentity(name, token)
  if (!check.ok) {
    return { ok: false, reason: check.reason }
  }

  // 保留首次署名时间：重复保存不应把 createdAt 刷新成现在
  const existing = readIdentity(path).identity
  const now = Date.now()

  const dept = input.dept?.trim()
  const identity: Identity = {
    name,
    token,
    ...(dept ? { dept } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  try {
    mkdirSync(dirname(path), { recursive: true })

    // 先写临时文件，再 rename —— rename 在同一文件系统上是原子的
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(identity, null, 2) + '\n', 'utf8')

    // POSIX 权限收窄到仅本人可读写。Windows 上 chmod 是 no-op，会静默忽略。
    try {
      chmodSync(tmp, 0o600)
    } catch {
      /* Windows 无此语义，忽略 */
    }

    renameSync(tmp, path)
  } catch (err) {
    return { ok: false, reason: `保存失败: ${messageOf(err)}` }
  }

  return { ok: true, identity }
}

/** 删除本地身份（用于「退出署名」/ 换人）。 */
export function clearIdentity(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}