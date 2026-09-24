/**
 * 插件全局配置 —— 团队统一部署时的**唯一配置面**。
 *
 * ## 为什么配置要集中在一个文件
 *
 * 团队铺开时，每个人机器上的差异应当只有「身份」一项，其余（上报地址、
 * 批量参数、outbox 位置）都应来自同一份下发配置。把它们散在各处
 * （环境变量一份、代码默认值一份、部署脚本一份）就会出现
 * 「张三的机器上报到测试环境」这种极难排查的问题。
 *
 * ## 三级取值（后者被前者覆盖）
 *
 * ```
 * 代码默认值  <  环境变量  <  插件 config
 * ```
 *
 * 环境变量这一级是刻意保留的：CI / 容器 / 临时排障时不必改 YAML。
 *
 * ## 未署名 = 不采集也不上报（★ 合规底线，不要放宽）
 *
 * `evaluateStatus()` 里「没身份 → 不上报」这条判断是**合规要求的落点**。
 * 不要为了「先收着数据」而加 `unknown` 兜底 —— 那是未授权的数据采集，
 * 而且会在看板上表现为一堆查不出来源的用量。
 */

import { isSigned, type Identity } from '@ai-token-report/shared'

/** 生效配置（所有可选字段都已填好默认值）。 */
export interface EffectiveConfig {
  /** ★ 插件实例名。同时用作上报 `client.name`，让服务端能区分来源。 */
  name: string
  /**
   * ★ 上报凭证（appKey）。经 `Authorization: Bearer <appKey>` 发出。
   *
   * 🚨 **只进请求头，绝不进请求体、日志或错误信息。**
   *   它决定了服务端认定你是谁，泄漏等于身份被冒用。
   */
  appKey: string
  /**
   * 计费上报地址（完整 URL）。
   *
   * 默认指向本仓部门服务端的 `POST /api/v1/token-usage`。
   */
  endpoint: string
  /** 批量发送参数。 */
  batch: {
    /** 单批最大条数。 */
    maxRecords: number
    /** 定时冲刷间隔（毫秒）。 */
    flushIntervalMillis: number
    /** 单次请求超时（毫秒）。 */
    timeoutMillis: number
  }
  /** 磁盘 outbox（崩溃不丢数据）。 */
  outbox: {
    /** 关闭 outbox。默认 `true`（开着）。 */
    enabled: boolean
    /** 自定义目录。缺省 `$DSH_HOME/token-report/outbox`。 */
    dir?: string
    /** 未投递文件的总字节上限，超过后丢弃**最旧**的并告警。 */
    maxBytes: number
  }
  /** 装配开关：便于排障时逐项关掉。 */
  features: {
    /** 注册 telemetry 后端（实时上报）。关掉即完全不上报。 */
    reporting: boolean
    /** 注册给 Agent 用的统计工具。 */
    tools: boolean
    /** 注册 `ctx.tokenReport` 服务，供其它插件取数。 */
    service: boolean
  }
  /**
   * 本机上是否启用本地 SQLite 库查询。
   *
   * ⚠️ 默认 `false`：`core/db` 依赖 `bun:sqlite`，而 DSH 宿主跑在 **Node** 上，
   *   加载它会直接抛错。只有确认宿主是 Bun 时才应打开。
   */
  localDb: boolean
  /** 固定身份（IT 统一部署场景）。留空则读本机身份文件。 */
  user?: { name: string; token: string; dept?: string }
  /** DSH home，一般不需要手动指定。 */
  dshHome?: string
}

/** 默认上报地址 —— 与本仓部门服务端契约一致（`ARCHITECTURE.md` §5.2）。 */
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787/api/v1/token-usage'

/** 默认插件名。 */
export const DEFAULT_NAME = 'dsh-token-report'

export const DEFAULTS = {
  batch: {
    maxRecords: 50,
    flushIntervalMillis: 10_000,
    timeoutMillis: 15_000,
  },
  outbox: {
    enabled: true,
    maxBytes: 32 * 1024 * 1024, // 32 MB：约 20 万条记录，足够覆盖任何内网中断
  },
} as const

/** 从环境变量读一个可选字符串。 */
function envString(key: string): string | undefined {
  const v = process.env[key]
  return v !== undefined && v.trim() !== '' ? v.trim() : undefined
}

function envNumber(key: string): number | undefined {
  const raw = envString(key)
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function envBool(key: string): boolean | undefined {
  const raw = envString(key)?.toLowerCase()
  if (raw === undefined) return undefined
  if (raw === '1' || raw === 'true' || raw === 'yes') return true
  if (raw === '0' || raw === 'false' || raw === 'no') return false
  return undefined
}

/**
 * 环境变量名一览（写在代码里而不是散落各处，便于文档与自检引用）。
 *
 * 命名前缀统一为 `DSH_TOKEN_REPORT_`，与 CLI 的 `DSH_REPORT_*` 刻意区分开：
 * 两者是不同的部署面，混用会让「我改了变量为什么没生效」变成一个谜题。
 */
export const ENV = {
  name: 'DSH_TOKEN_REPORT_NAME',
  appKey: 'DSH_TOKEN_REPORT_APP_KEY',
  endpoint: 'DSH_TOKEN_REPORT_ENDPOINT',
  maxRecords: 'DSH_TOKEN_REPORT_BATCH_MAX',
  flushInterval: 'DSH_TOKEN_REPORT_FLUSH_INTERVAL_MS',
  timeout: 'DSH_TOKEN_REPORT_TIMEOUT_MS',
  outboxEnabled: 'DSH_TOKEN_REPORT_OUTBOX',
  outboxDir: 'DSH_TOKEN_REPORT_OUTBOX_DIR',
  outboxMaxBytes: 'DSH_TOKEN_REPORT_OUTBOX_MAX_BYTES',
  localDb: 'DSH_TOKEN_REPORT_LOCAL_DB',
  userName: 'DSH_TOKEN_REPORT_USER_NAME',
  userToken: 'DSH_TOKEN_REPORT_USER_TOKEN',
  dept: 'DSH_TOKEN_REPORT_DEPT',
} as const

/** 插件 config 的原始形状（全部可选 —— 团队下发的 YAML 里通常只写几项）。 */
export interface RawConfig {
  name?: string
  appKey?: string
  endpoint?: string
  batch?: {
    maxRecords?: number
    flushIntervalMillis?: number
    timeoutMillis?: number
  }
  outbox?: {
    enabled?: boolean
    dir?: string
    maxBytes?: number
  }
  features?: {
    reporting?: boolean
    tools?: boolean
    service?: boolean
  }
  localDb?: boolean
  user?: { name?: string; token?: string; dept?: string }
  dshHome?: string
}

/** 正数校验：非法值**回退默认**而不是抛错 —— 一个写错的数字不该让整个 DSH 起不来。 */
function positive(v: number | undefined, fallback: number): number {
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : fallback
}

/**
 * 把「config + 环境变量」归一成生效配置。
 *
 * 纯函数、无 IO —— 便于单测逐个断言优先级，而不是靠读 YAML 猜。
 */
export function resolveConfig(raw: RawConfig = {}): EffectiveConfig {
  const envUser = {
    name: envString(ENV.userName),
    token: envString(ENV.userToken),
    dept: envString(ENV.dept),
  }

  // 身份的优先级：config.user > 环境变量。两处的必填项（name/token）必须**同时**
  // 存在才认这一级，否则视为「这一级没配」回退下一级 —— 半份身份比没有更危险，
  // 它会让 evaluateStatus 误判成「已署名」却带着空 token 发请求。
  const cfgName = raw.user?.name?.trim()
  const cfgToken = raw.user?.token?.trim()
  const user =
    cfgName && cfgToken
      ? { name: cfgName, token: cfgToken, ...(raw.user?.dept?.trim() ? { dept: raw.user.dept.trim() } : {}) }
      : envUser.name && envUser.token
        ? { name: envUser.name, token: envUser.token, ...(envUser.dept ? { dept: envUser.dept } : {}) }
        : undefined

  const outboxDir = raw.outbox?.dir?.trim() || envString(ENV.outboxDir)

  return {
    name: raw.name?.trim() || envString(ENV.name) || DEFAULT_NAME,
    appKey: raw.appKey?.trim() || envString(ENV.appKey) || '',
    endpoint: raw.endpoint?.trim() || envString(ENV.endpoint) || DEFAULT_ENDPOINT,
    batch: {
      maxRecords: positive(raw.batch?.maxRecords ?? envNumber(ENV.maxRecords), DEFAULTS.batch.maxRecords),
      flushIntervalMillis: positive(
        raw.batch?.flushIntervalMillis ?? envNumber(ENV.flushInterval),
        DEFAULTS.batch.flushIntervalMillis,
      ),
      timeoutMillis: positive(raw.batch?.timeoutMillis ?? envNumber(ENV.timeout), DEFAULTS.batch.timeoutMillis),
    },
    outbox: {
      enabled: raw.outbox?.enabled ?? envBool(ENV.outboxEnabled) ?? DEFAULTS.outbox.enabled,
      ...(outboxDir ? { dir: outboxDir } : {}),
      maxBytes: positive(raw.outbox?.maxBytes ?? envNumber(ENV.outboxMaxBytes), DEFAULTS.outbox.maxBytes),
    },
    features: {
      reporting: raw.features?.reporting ?? true,
      tools: raw.features?.tools ?? true,
      service: raw.features?.service ?? true,
    },
    // ⚠️ 默认 false：宿主是 Node 时 `bun:sqlite` 不存在，开了会直接起不来
    localDb: raw.localDb ?? envBool(ENV.localDb) ?? false,
    ...(user ? { user } : {}),
    ...(raw.dshHome ? { dshHome: raw.dshHome } : {}),
  }
}

/** 上报是否可用（有凭证 + 有地址 + 功能开关打开）。 */
export function canReport(config: EffectiveConfig): boolean {
  return config.features.reporting && config.appKey !== '' && config.endpoint !== ''
}

/**
 * 派生「自称的身份标识」。
 *
 * ⚠️ **服务端会忽略这个值**（`WireClientIdentity.userId` 的契约如此），
 *   它只用于排查。真正决定归属的是 `appKey` 解析出来的身份 ——
 *   所以这里不必也不该试图「填对」，填错也不会冒用别人。
 */
export function claimedUserId(config: EffectiveConfig, identity: Identity | null): string {
  return identity?.name ?? config.user?.name ?? 'unconfigured'
}

/**
 * 校验生效配置，返回**面向运维**的问题清单（空数组 = 没问题）。
 *
 * 刻意返回清单而不是抛错：上报没配好不该让 DSH 起不来，
 * 但一定要在启动时把「缺什么、去哪儿配」讲清楚。
 */
export function validateConfig(config: EffectiveConfig): string[] {
  const problems: string[] = []
  if (!config.appKey) {
    problems.push(
      `未配置上报凭证 appKey —— 上报不会启动。\n` +
        `  配置方式：插件 config 的 appKey，或环境变量 ${ENV.appKey}`,
    )
  }
  if (!/^https?:\/\//i.test(config.endpoint)) {
    problems.push(`endpoint 必须是 http(s) 地址，当前为 "${config.endpoint}"`)
  }
  if (config.localDb) {
    problems.push(
      'localDb = true —— 本地库查询依赖 bun:sqlite，宿主不是 Bun 时会加载失败。\n' +
        '  仅在确认宿主为 Bun 时打开；否则保持默认值 false。',
    )
  }
  return problems
}

/** 该身份是否可用（两个必填项都非空）。 */
export function identityUsable(identity: Pick<Identity, 'name' | 'token'> | null): boolean {
  return isSigned(identity)
}