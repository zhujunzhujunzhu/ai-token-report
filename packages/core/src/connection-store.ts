/**
 * 本机连接配置 —— 「服务端地址 + appKey」以及面板偏好的**唯一一份**落盘实现。
 *
 * ## 文件位置与那个历史名字
 *
 * ```
 * <dataDir>/plugin-connection.json
 * ```
 *
 * 名字里的 `plugin-` 是历史：它最早只由 DSH 插件的「连接配置」面板写。
 * 但内容从来没有插件专有的东西 —— 它回答的是「本机该往哪个服务端上报、
 * 拿什么凭证」，而**本地页面的「配置」弹框问的正是同一件事**
 * （见 `server/src/identity-route.ts`）。两个入口共用一份，才有
 * 「在哪儿填一次就够了」。文件名**不改**：改名会让已经配好的机器
 * 一夜之间读不到自己的地址与密钥，而且不报错，只是「又要重填一遍」。
 *
 * ## 为什么它和 `identity.json` 是两份文件
 *
 * `identity.json` 回答「我是谁」（服务端校验过的姓名 + 分组 + 凭证），
 * 这一份回答「连哪台服务端、有哪些本机偏好」。两者必须成对才有意义，
 * 所以强地址（换服务端）与换凭证走同一条路：**改地址必须同时给 appKey**。
 *
 * ## 三条实现约束
 *
 * 1. **原子写入**（临时文件 + rename）：写到一半被杀会留下截断 JSON，
 *    下次启动读不出来 —— 表现是「我明明配过了」。
 * 2. **权限 0600**：文件含 appKey（凭证）。Windows 上 `chmod` 是 no-op，
 *    靠目录 ACL 保护（与 `identity-store.ts` 同一条已知差异）。
 * 3. **合并写，不覆盖别人的键**：这份文件同时装着插件的偏好
 *    （上报间隔 / 面板位置 / 会话日志根 / 其它来源）。谁写谁只动自己那几个键 ——
 *    整份覆写等于「在本地页填一次就把插件的设置清空」，而且不报错。
 *    唯一例外是文件本身不是合法 JSON 对象：那时**拒绝覆盖**并说清原因，
 *    因为那份内容可能还有救（证据不该被我们销毁）。
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

import { baseUrlOf, normalizeBaseUrl } from '@ai-token-report/shared'

import { resolvePaths } from './home.js'

/** 落盘文件名。见文件头「那个历史名字」——改它等于让所有人重填一次。 */
export const CONNECTION_FILE_NAME = 'plugin-connection.json'

/**
 * 连接配置里与服务端有关的那两项。
 *
 * ⚠️ **成对才认**：只有地址没密钥（或反之）不算配好 —— 半份连接会让
 * 「连哪台」与「我是谁」指向不同的地方，而两边都不报错。
 */
export interface ConnectionCredential {
  /** 服务端根地址（无尾斜杠、无 `/api/...` 后缀）。 */
  baseUrl: string
  /** 上报凭证（appKey）。**只进请求头**，绝不进日志或错误信息。 */
  appKey: string
}

/** `<dataDir>/plugin-connection.json`。 */
export function connectionFileIn(dataDir: string): string {
  return join(dataDir, CONNECTION_FILE_NAME)
}

/**
 * 解析连接配置的路径。
 *
 * ⚠️ 与 `identityPath()` 同一个道理：数据目录的缺省值只在 `home.ts` 定义一处，
 *   这里再拼一遍就会出现「身份在 A 目录、连接在 B 目录」而两边都不报错。
 */
export function connectionPath(dshHome?: string, dataDir?: string): string {
  return connectionFileIn(
    resolvePaths({
      ...(dshHome ? { dshHome } : {}),
      ...(dataDir ? { dataDir } : {}),
    }).dataDir,
  )
}

/** 读取结果。`text` 为 null 表示文件不存在或读不了，`error` 说明后者。 */
export interface ConnectionTextResult {
  text: string | null
  error?: string
}

/**
 * 读原始文本。
 *
 * ★ 抛错改成返回值：调用方在两条路上都需要「没有」与「读不了」区分开
 *   （不存在 → 照常写入；读不了 → 拒绝覆盖，见文件头约束 3）。
 */
export function readConnectionText(path: string): ConnectionTextResult {
  try {
    return { text: readFileSync(path, 'utf8') }
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return { text: null }
    return { text: null, error: messageOf(err) }
  }
}

/** 解析结果。`value` 为 null 表示没有那份文件（或读不了 / 坏了，见 `error`）。 */
export interface ReadConnectionResult {
  value: Record<string, unknown> | null
  /** 文件在但不可用时的原因（可直接展示）。 */
  error?: string
}

/**
 * 读并解析连接配置。
 *
 * ★ 与 `identity-store` 的 `readIdentity()` 同一个形状：**不抛错**，
 *   把「没有」「读不了」「坏了」三件事分别说清楚 ——
 *   调用方对这三种情况的处理完全不同（照常写入 / 拒绝覆盖 / 从空开始）：
 *
 *   | 情况 | `value` | `error` | 调用方该做什么 |
 *   |---|---|---|---|
 *   | 文件不存在 | `null` | 无 | 当作「没配过」，可以照常写入 |
 *   | 空文件 | `{}` | 无 | 同上（外部工具截断过，而里面本来也没内容） |
 *   | 坏了 / 读不了 | `null` | 有 | **拒绝覆盖**并说清原因 |
 */
export function readConnectionFile(path: string): ReadConnectionResult {
  const read = readConnectionText(path)
  if (read.error !== undefined) return { value: null, error: `本机连接配置读不了: ${read.error}` }
  if (read.text === null) return { value: null }
  if (read.text.trim() === '') return { value: {} }

  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch {
    return { value: null, error: '本机连接配置不是合法 JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, error: '本机连接配置的内容不是对象' }
  }
  return { value: parsed as Record<string, unknown> }
}

/** 写入结果。失败时 `reason` 可直接展示给用户。 */
export interface WriteConnectionResult {
  ok: boolean
  reason?: string
}

/**
 * 原子写一份连接配置（0600）。
 *
 * 传 `null` 表示**删除**（回滚用：本来就没有这份文件时，回滚等于删掉它）。
 */
export function writeConnectionText(path: string, text: string | null): WriteConnectionResult {
  try {
    if (text === null) {
      rmSync(path, { force: true })
      return { ok: true }
    }
    mkdirSync(dirname(path), { recursive: true })
    // 先写临时文件再 rename —— rename 在同一文件系统上是原子的
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, text, { mode: 0o600 })
      renameSync(temp, path)
    } finally {
      // rename 成功后临时文件已经不存在，force 让这次清理对两种情况都安全
      rmSync(temp, { force: true })
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: `本机连接配置写入失败: ${messageOf(err)}` }
  }
}

/**
 * 从已解析的落盘内容里取「服务端地址 + appKey」。
 *
 * 兼容两种写法：
 * - 现役：`{ baseUrl, appKey }`；
 * - 旧版插件：`{ endpoint, appKey }`（那时面板里填的是完整上报地址）。
 *
 * @throws 地址非法（`normalizeBaseUrl` 的语义）。调用方要么自己接住当作
 *   「这份配置不可用」，要么让整次读取失败 —— 两种处理都由调用方决定，
 *   因为「坏地址该不该连累别的偏好」在不同入口的答案不一样。
 */
export function connectionCredentialOf(value: Record<string, unknown>): ConnectionCredential | undefined {
  const appKey = typeof value['appKey'] === 'string' ? value['appKey'] : ''
  if (!appKey) return undefined

  if (typeof value['baseUrl'] === 'string' && value['baseUrl']) {
    return { baseUrl: normalizeBaseUrl(value['baseUrl']), appKey }
  }
  if (typeof value['endpoint'] === 'string' && value['endpoint']) {
    return { baseUrl: baseUrlOf(value['endpoint']), appKey }
  }
  return undefined
}

/** 合并写的结果。`value` 是落盘后的完整内容（便于调用方回显）。 */
export interface UpdateConnectionResult {
  ok: boolean
  reason?: string
  value?: Record<string, unknown>
}

/**
 * 把 `patch` 并进连接配置（保留其它键），原子落盘。
 *
 * - 文件不存在 / 是空文件 → 从 `{}` 开始（与 `identity-store` 对空文件的处理一致：
 *   那是「没写过」，不是「坏了」）；
 * - 文件存在但不是**合法 JSON 对象**（含读不了）→ **拒绝覆盖**并说明原因；
 * - `patch` 里的 `undefined` 一律忽略（等价于「这一项不改」），
 *   清空某一项要显式写 `null` 或空值。
 */
export function updateConnectionFile(path: string, patch: Record<string, unknown>): UpdateConnectionResult {
  const read = readConnectionFile(path)
  if (read.error !== undefined) {
    // 坏了 / 读不了 → **拒绝覆盖**：那份内容可能还有救，销毁证据比报错糟得多。
    return { ok: false, reason: `${read.error}（${path}），已拒绝覆盖；请修好或删掉它再试` }
  }

  // `value` 为 null 且没有 error = 文件不存在 → 从空对象开始（第一次保存）
  const next: Record<string, unknown> = { ...(read.value ?? {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key] = value
  }

  const written = writeConnectionText(path, JSON.stringify(next))
  if (!written.ok) return { ok: false, ...(written.reason ? { reason: written.reason } : {}) }
  return { ok: true, value: next }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
