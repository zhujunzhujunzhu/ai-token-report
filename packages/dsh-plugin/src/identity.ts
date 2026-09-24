/**
 * 插件侧身份解析。
 *
 * ## 与本地页共用同一份身份文件
 *
 * ```
 * $DSH_HOME/token-report/identity.json
 * ```
 *
 * 也就是说：**员工在哪里填一次就够了**。
 * - 先在本地页填 → 插件读同一份文件，立刻生效
 * - 先在插件里填 → 本地页读同一份文件，不重复问
 *
 * 复用 `@ai-token-report/core` 的存储实现，而不是自己再写一遍读写 ——
 * 两处实现必然漂移，而身份文件是双方都要解析的格式。
 *
 * ## 未署名 = 不上报（已确认的行为）
 *
 * ★ 插件启动时若未署名，**不启动上报队列**，并在 DSH 里给出提示。
 *   这比「先按 unknown 收着」干净：不会留下任何未授权的数据。
 *
 * 提示频次需要克制 —— 每次会话都弹会让人烦到直接卸载插件。
 * 这里的策略是：**每个进程生命周期只提示一次**，且措辞说明「怎么填」而非
 * 单纯抱怨「你没填」。
 */

import { resolvePaths, readIdentity, writeIdentity, clearIdentity } from '@ai-token-report/core'
import { isSigned, toAssertion, type Identity, type IdentityAssertion } from '@ai-token-report/shared'

/** 身份就绪状态。 */
export type IdentityState =
  | { ready: true; identity: Identity; assertion: IdentityAssertion }
  | { ready: false; reason: 'missing' | 'corrupt'; detail?: string }

export interface IdentityResolverOptions {
  /** DSH home。默认 `$DSH_HOME` 或 `~/.dsh`。 */
  dshHome?: string
  /**
   * 插件配置里直接写死的署名（最高优先级）。
   *
   * 保留这条路径是为了「IT 统一部署」的场景仍然可行 ——
   * 但默认推荐让员工自己填，合规上更干净。
   */
  configIdentity?: { name: string; token: string; dept?: string }
}

export class IdentityResolver {
  readonly #dshHome: string
  readonly #configIdentity: { name: string; token: string; dept?: string } | undefined

  /** 每个进程生命周期只提示一次，避免每次会话都打扰用户。 */
  #warned = false

  constructor(options: IdentityResolverOptions = {}) {
    this.#dshHome = resolvePaths(options.dshHome).dshHome
    this.#configIdentity = options.configIdentity
  }

  get identityFilePath(): string {
    return resolvePaths(this.#dshHome).identityPath
  }

  /**
   * 解析当前身份。
   *
   * 优先级：插件配置 > 本地身份文件。
   */
  resolve(): IdentityState {
    // 1. 插件配置（IT 统一部署场景）
    if (this.#configIdentity) {
      const raw = this.#configIdentity
      const name = raw.name.trim()
      const token = raw.token.trim()
      if (name && token) {
        const identity: Identity = {
          name,
          token,
          ...(raw.dept?.trim() ? { dept: raw.dept.trim() } : {}),
          createdAt: 0,
          updatedAt: 0,
        }
        return { ready: true, identity, assertion: toAssertion(identity) }
      }
    }

    // 2. 本地身份文件（员工自己在页面或插件里填的）
    const result = readIdentity(this.identityFilePath)

    if (result.identity && isSigned(result.identity)) {
      return {
        ready: true,
        identity: result.identity,
        assertion: toAssertion(result.identity),
      }
    }

    // 文件损坏与「没填过」要分开报：前者需要用户重新填，后者需要先知道去哪填
    if (result.error) {
      return { ready: false, reason: 'corrupt', detail: result.error }
    }
    return { ready: false, reason: 'missing' }
  }

  /** 是否已署名。 */
  get signed(): boolean {
    return this.resolve().ready
  }

  /**
   * 构造给用户看的提示文案。
   *
   * ★ 措辞要点：说明**去哪里填**，而不是抱怨「你没填」。
   *   只说「未署名」的提示会让用户卡住 —— 他们不知道下一步该做什么。
   */
  describeProblem(): string {
    const state = this.resolve()

    if (state.ready) return ''

    const where = this.identityFilePath

    if (state.reason === 'corrupt') {
      return [
        '⚠ token 上报未启用：本地身份文件无法解析。',
        `  文件：${where}`,
        `  原因：${state.detail ?? '未知'}`,
        '  处理：运行 `dsh-token --web` 打开页面重新填写署名。',
      ].join('\n')
    }

    return [
      '⚠ token 上报未启用：尚未署名。',
      '  ★ 在你填写之前，本插件不采集、也不上报任何数据。',
      '  填写方式（任选其一）：',
      '    1. 运行 `dsh-token --web`，在打开的页面里填写姓名与 token',
      `    2. 手动创建 ${where}，内容：`,
      '       { "name": "你的姓名", "token": "管理员发放的 token" }',
    ].join('\n')
  }

  /**
   * 输出一次提示（每个进程只输出一次）。
   *
   * 返回是否真的输出了。调用方通常不需要关心返回值。
   */
  warnOnce(write: (msg: string) => void = (m) => process.stderr.write(m + '\n')): boolean {
    if (this.#warned) return false
    if (this.resolve().ready) return false

    this.#warned = true
    write(this.describeProblem())
    return true
  }

  /**
   * 由插件写入署名（例如用户在 DSH 里通过命令配置）。
   *
   * 复用 core 的原子写入与校验，避免两套实现漂移。
   */
  save(input: { name: string; token: string; dept?: string }): { ok: boolean; reason?: string } {
    const r = writeIdentity(this.identityFilePath, input)
    if (!r.ok) return { ok: false, reason: r.reason }
    // 保存成功后重置提示状态，便于后续再次未署名的场景
    this.#warned = false
    return { ok: true }
  }

  /** 清除署名 —— 清除后上报应立即停止。 */
  clear(): boolean {
    return clearIdentity(this.identityFilePath)
  }
}