/**
 * 本机项目名称别名 —— `<数据目录>/project-aliases.txt` 的解析、校验与装载。
 *
 * ## 它解决什么问题
 *
 * 本机形态（插件面板 / `token_usage` 工具 / 本地页 / CLI）的项目维度取 `cwd` 的
 * **最后一段路径**（`aggregate.ts` 的 `projectName()`：`D:\Coding\my-project` →
 * `my-project`）。这在两个方向上都会出错：
 *
 * - **一个项目散成好几行**：仓库根与各子目录各占一行（`D:\Coding\presales-kb-parent`
 *   与它下面的 `presales-kb-backend` 是两个项目名）；
 * - **不同项目被并成一行**：两个不相干的 `core` 目录共用一个名字。
 *
 * 部门看板早就有这件事的解（`project_alias` 表），但它是**部门口径**、只在
 * 上报库那条路径生效（本机库没有那张表）。于是同一台机器上「本机看到的项目名」
 * 与「看板上看到的」可以不同，而使用者在本机既改不了它、也解释不了它。
 * 这个文件就是本机那一层：**个人偏好**，与部门规则互不影响。
 *
 * ## 四条口径
 *
 * 1. **只改显示。** `usage_event.cwd` 永远是上报当时的原值，也不参与上报 ——
 *    别名只在本机取数时把 `cwd` 折叠成一个名字（改一条规则立刻对历史生效，
 *    改回去也立刻生效，不需要任何回填）。**上报出去的数据一个字节都不变。**
 * 2. **匹配语义与服务端那一套完全一致**（`project-alias.ts` 的
 *    `projectResolverFromRules()`）：含分隔符 = 路径前缀（按分隔符边界），
 *    不含分隔符 = 仓库名（cwd 的任一路径段逐字全等）；路径模式优先、同模式最长优先；
 *    大小写**不折叠**；未命中回落 `projectName()`。
 *    用同一份规则可以同时喂本机与看板，两边的项目名因此不会因为「两套匹配实现」分叉。
 * 3. **整份拒绝，不做部分接受**（同 `pricing.json`）：任何一行非法 ⇒ 一条都不生效，
 *    原因经 `note` 原样带出去。半个别名表会让一部分项目名看着「正常」、另一部分
 *    没折 —— 那是本功能最难发现的一种失效。
 * 4. **文件格式就是面板里那个文本框的内容**（逐字节相同）：一行一条
 *    `项目名 = 匹配值, 匹配值`，`#` 开头是注释，空行忽略。不引入第二种格式，
 *    于是「面板里看到的」与「磁盘上存的」不可能不一致。
 *
 * ```
 * # 左边是显示的项目名，右边是要折进去的路径或仓库名（逗号分隔）
 * presales-kb-parent = D:\Coding\my-project, presales-kb-parent
 * ai-token-report = ai-token-report
 * ```
 *
 * ## 为什么所有消费方都读同一份文件
 *
 * 插件面板、本地页、CLI 都从**数据目录**读它（与会话日志根、`pricing.json` 同一处）：
 * 同一台机器上「面板里叫这个名字、本地页里叫那个名字」本身就是一个 bug 形状，
 * 而它不会报错、只会让人以为数据对不上。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { projectName, type ProjectNameResolver } from '../aggregate.js'
import { atomicWriteText } from '../connection-store.js'
import {
  normalizeProjectPrefix,
  projectAliasNameError,
  projectPrefixError,
  projectResolverFromRules,
} from './project-alias.js'

/**
 * 落盘文件名。
 *
 * ★ 放在**数据目录**里（与 `pricing.json` 同一处）：它是配置，不进可重建的
 *   `usage.sqlite`；也不跟着会话日志根走 —— 换一个 DSH home 不该换掉项目口径。
 */
export const PROJECT_ALIAS_FILE_NAME = 'project-aliases.txt'

/** `<数据目录>/project-aliases.txt`。 */
export function projectAliasFileIn(dataDir: string): string {
  return join(dataDir, PROJECT_ALIAS_FILE_NAME)
}

/**
 * 一条本机别名规则。
 *
 * ⚠️ `prefix` 存的是**归一化之后**的匹配值（尾部路径分隔符已去掉）：规则与
 *   要匹配的 cwd 必须用同一个函数归一化，只归一化一侧的结果是
 *   「`D:\a\proj\` 这条规则永远不命中」，而它在文件里看起来完全正确。
 */
export interface LocalProjectAliasRule {
  /** 匹配值：含分隔符 = 路径前缀，不含 = 仓库名。已归一化。 */
  prefix: string
  /** 显示的项目名（允许中文与 `/`）。 */
  alias: string
}

/**
 * 规则条数上限。
 *
 * 不是洁癖：每条规则在**每一次按项目取数**时都会参与匹配（事件级是几十条量级，
 * 但规则是每行一次线性扫描），而一份几百条的别名表通常意味着有人在拿它当
 * 「项目名映射总表」用 —— 那种表该配到部门看板上去（那才是全员口径）。
 * 上限也顺带兜住「请求体里塞一万行」这种畸形输入。
 */
export const MAX_PROJECT_ALIAS_RULES = 200

/**
 * 文本长度上限（字符）。
 *
 * 与条数上限同源：正常几十行、一两千字符；64 KiB 足够写下任何手写配置，
 * 再大就只可能是把别的文件粘进来了。
 */
export const MAX_PROJECT_ALIAS_TEXT_LENGTH = 64 * 1024

/** 解析出的一处问题。 */
export interface ProjectAliasTextError {
  /** 1-based 行号；`0` = 整份文件级问题（如超过条数上限）。 */
  line: number
  /** 出问题的那一段（原始行或单个匹配值），便于对回文件。 */
  text: string
  /** 可直接展示的原因。 */
  reason: string
}

/**
 * 解析结果。
 *
 * ★ 有 `errors` 就一定不 `ok`：见文件头口径 3（整份拒绝）。
 *   调用方不要自己去过滤 `rules` —— 那条路会让半份规则生效。
 */
export type ProjectAliasTextParse =
  | { ok: true; rules: LocalProjectAliasRule[] }
  | { ok: false; errors: ProjectAliasTextError[] }

/** 分隔符：只认 `=`（半角与全角）。 */
const SEPARATORS = ['=', '＝']

/**
 * 找出分隔符的位置。
 *
 * 🚨 **绝不接受 `:` / `：`**：Windows 路径里到处是冒号（`D:\Coding\my-project`），
 *   把冒号当分隔符会把 `presales = D:\Coding\x` 切成一个显示名 `presales = D`
 *   和一个匹配值 `\Coding\x` —— 页面上会得到一个名字古怪的项目，
 *   而错误信息完全指不到真正的原因。
 */
function separatorIndex(line: string): number {
  let best = -1
  for (const separator of SEPARATORS) {
    const at = line.indexOf(separator)
    if (at >= 0 && (best < 0 || at < best)) best = at
  }
  return best
}

/**
 * 把文本解析成规则。
 *
 * 逐行处理，遇到问题**继续扫完**（一次把这一份配置的所有毛病都报出来 ——
 * 只报第一处会让使用者「改一行、再存一次、再报下一处」来回好几轮）。
 *
 * 容忍的写法（都是使用者会真实写出来的）：
 * - 全角等号 `＝`、全角逗号 `，`；
 * - 整段方括号：`presales-kb-parent = [ D:\a\proj, presales-kb-parent ]`
 *   —— 括号只是**粘贴形态**，不表达任何额外语义；
 * - `#` 开头的注释行与空行、行首尾空白。
 *
 * 拒绝的写法（都是会静默出错的那一类）：缺 `=`、显示名为空、匹配值为空、
 * 匹配值非法（见 `projectPrefixError`：文件系统根、裸盘符 `D:`）、显示名非法、
 * 同一条匹配值出现两次（哪一个生效不可预期）。
 */
export function parseProjectAliasText(text: string): ProjectAliasTextParse {
  const rules: LocalProjectAliasRule[] = []
  const errors: ProjectAliasTextError[] = []
  /** 归一化后的匹配值 → 首次出现的行号（重复检测）。 */
  const seen = new Map<string, number>()

  if (text.length > MAX_PROJECT_ALIAS_TEXT_LENGTH) {
    errors.push({
      line: 0,
      text: '',
      reason: `配置太长（${text.length} 字符，上限 ${MAX_PROJECT_ALIAS_TEXT_LENGTH}）`,
    })
    return { ok: false, errors }
  }
  if (text.includes('\0')) {
    errors.push({ line: 0, text: '', reason: '配置里不能包含空字符' })
    return { ok: false, errors }
  }

  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!
    const line = raw.trim()
    // 空行与注释行不是错误：人们需要在自己的配置里写说明。
    if (line === '' || line.startsWith('#')) continue
    const lineNo = index + 1

    const at = separatorIndex(line)
    if (at < 0) {
      errors.push({
        line: lineNo,
        text: raw,
        reason: '缺少 =（格式：项目名 = 路径或仓库名，多个匹配值用逗号分隔）',
      })
      continue
    }

    const alias = line.slice(0, at).trim()
    const right = line.slice(at + 1).trim()
    const aliasError = projectAliasNameError(alias)
    if (aliasError !== null) {
      errors.push({ line: lineNo, text: alias, reason: `项目名不可用：${aliasError}` })
      continue
    }

    // 方括号只是粘贴形态：`[ a, b ]` 与 `a, b` 是同一件事。
    // ⚠️ 只有一个 `[` 而没有 `]` 时必须报错而不是照常切分 —— 那多半是粘漏了一半。
    let inner = right
    if (inner.startsWith('[')) {
      if (!inner.endsWith(']')) {
        errors.push({ line: lineNo, text: raw, reason: '方括号没有闭合' })
        continue
      }
      inner = inner.slice(1, -1)
    } else if (inner.endsWith(']')) {
      errors.push({ line: lineNo, text: raw, reason: '方括号没有闭合' })
      continue
    }

    const values = inner
      .split(/[,，]/)
      .map((value) => value.trim())
      .filter((value) => value !== '')
    if (values.length === 0) {
      errors.push({ line: lineNo, text: raw, reason: '等号右边至少要有一个路径或仓库名' })
      continue
    }

    for (const value of values) {
      const prefixError = projectPrefixError(value)
      if (prefixError !== null) {
        errors.push({ line: lineNo, text: value, reason: prefixError })
        continue
      }
      const key = normalizeProjectPrefix(value)
      const first = seen.get(key)
      if (first !== undefined) {
        errors.push({
          line: lineNo,
          text: value,
          reason: `匹配值与第 ${first} 行重复（同一条匹配值只能配一次，否则哪条生效不可预期）`,
        })
        continue
      }
      seen.set(key, lineNo)
      rules.push({ prefix: key, alias })
    }
  }

  if (rules.length > MAX_PROJECT_ALIAS_RULES) {
    errors.push({
      line: 0,
      text: '',
      reason: `规则条数超过上限（${rules.length} > ${MAX_PROJECT_ALIAS_RULES}）`,
    })
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, rules }
}

/** 把解析出的问题拼成一句可直接展示的原因（最多列 `cap` 处）。 */
export function formatProjectAliasErrors(
  errors: readonly ProjectAliasTextError[],
  cap = 3,
): string {
  const shown = errors
    .slice(0, cap)
    .map((error) => (error.line > 0 ? `第 ${error.line} 行：${error.reason}` : error.reason))
  const rest = errors.length - shown.length
  return shown.join('；') + (rest > 0 ? `；等 ${errors.length} 处问题` : '')
}

/**
 * 一次装载的结果。
 *
 * ★ `resolver` **恒可用**（没有规则 / 配置坏了时就是 `projectName` 本身）：
 *   调用方不该在取数路径上写 `if (rules.length)` 分支 —— 那样「别名没生效」
 *   与「别名生效了但没命中」会分叉成两条代码路径，而其中一条没人测。
 */
export interface LocalProjectAliases {
  /** 校验通过的规则（整份有效时才是它们；坏配置是空数组）。 */
  rules: readonly LocalProjectAliasRule[]
  /** 原始 `cwd` → 项目名；未命中回落 `projectName()`。 */
  resolver: ProjectNameResolver
  /**
   * 非空 = **一份都不生效**，以及为什么（读不了 / 解析失败 / 超上限）。
   *
   * 🚨 必须由展示层显示出来：静默不生效正是本仓最反对的失败模式 ——
   *   使用者会以为「我配了别名」，而页面上只是名字没变。
   */
  note: string | null
  /** 生效文件的路径；没有数据目录、也没显式给文件时为 `null`。 */
  path: string | null
  /** 文件原文（面板回填用）。没有文件时为空串。 */
  text: string
}

/**
 * 读取本机别名配置。**不抛错**：任何问题都折成 `note` + 「没有规则」。
 *
 * @param opts.dataDir - 数据目录（缺省 = 按 `<dataDir>/project-aliases.txt` 取）。
 * @param opts.file - 显式文件路径（优先于 `dataDir`，测试与 `--project-alias-file` 用）。
 */
export function loadLocalProjectAliases(opts: {
  dataDir?: string | null
  file?: string | null
}): LocalProjectAliases {
  const path = opts.file ?? (opts.dataDir ? projectAliasFileIn(opts.dataDir) : null)
  const none = (note: string | null, text = ''): LocalProjectAliases => ({
    rules: [],
    resolver: projectName,
    note,
    path,
    text,
  })

  // 没有数据目录 = 没配过（老调用方 / 测试注入），不是错误。
  if (path === null) return none(null)

  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as { code?: string }).code
    // 文件不存在 = 没配过。其余（权限 / 目录被占）**必须报出来**，
    // 否则「我明明配过」会被显示成「没配过」。
    if (code === 'ENOENT') return none(null)
    return none(`读取项目名称别名配置失败（${path}：${
      error instanceof Error ? error.message : String(error)
    }）；本次一条别名都不生效`)
  }

  // 空文件 = 没配过（外部工具截断过，而里面本来也没内容）：与「留空 = 不生效」同义。
  if (text.trim() === '') return none(null)

  const parsed = parseProjectAliasText(text)
  if (!parsed.ok) {
    return none(
      `项目名称别名配置有 ${parsed.errors.length} 处问题，整份未生效` +
        `（${formatProjectAliasErrors(parsed.errors)}）；项目名仍按 cwd 最后一段显示`,
      text,
    )
  }
  return {
    rules: parsed.rules,
    resolver: projectResolverFromRules(parsed.rules),
    note: null,
    path,
    text,
  }
}

/**
 * 校验并落盘（面板保存用）。
 *
 * ★ 顺序是「先整份校验、再写」：非法内容**一个字节都不落盘** ——
 *   否则下一次取数会读到一份坏配置，而使用者刚刚看到的是「保存失败」。
 * ★ 空文本 = **删掉文件**（`text === null` 那条路），不是写一个空文件：
 *   「留空 = 不生效」要能从磁盘上直接看出来。
 */
export function writeLocalProjectAliases(opts: {
  dataDir?: string | null
  file?: string | null
  text: string
}): { ok: boolean; reason?: string } {
  const path = opts.file ?? (opts.dataDir ? projectAliasFileIn(opts.dataDir) : null)
  if (path === null) {
    return { ok: false, reason: '没有数据目录，无法保存项目名称别名配置' }
  }
  if (opts.text.trim() !== '') {
    const parsed = parseProjectAliasText(opts.text)
    if (!parsed.ok) return { ok: false, reason: formatProjectAliasErrors(parsed.errors) }
  }
  const written = atomicWriteText(path, opts.text.trim() === '' ? null : opts.text, '项目名称别名配置')
  return written.ok ? { ok: true } : { ok: false, ...(written.reason ? { reason: written.reason } : {}) }
}