/**
 * 采集诊断页的纯判断：新鲜度分档、指标卡集合、节奏卡片。
 *
 * ★ 抽出来是为了能被 `bun test` 直接断言。渲染层（`DiagnosticsPanel.vue`）在 SSR 下
 *   **不会渲染 `el-table` 的列与行**（Element Plus 的表头与单元格由客户端渲染，
 *   服务端只输出空 `<tr>`，理由与 `rolesModel.ts` 同款），所以「新服务端才有的
 *   卡片会不会被旧服务端显示成 0」「静默阈值分档对不对」这类判断若只写在
 *   模板里，就只能靠点一遍页面才能发现坏掉 —— 而它们恰恰是最容易悄悄失效的。
 */
import type {
  DiagnosticsAttributionRow,
  DiagnosticsResponse,
  DiagnosticsSourceRow,
} from '@ai-token-report/shared'
// ⚠️ 直接 import 真实实现，**不要**在这里另写一份 formatCompact / formatPercent：
//   `utils/format.ts` 是纯函数、没有 Vue 依赖，本来就能被 `bun test` 直接跑。
//   复制一份的话，同一批数字会在卡片与表格里显示成两种写法，而没有任何报错。
import { formatCompact, formatCount, formatPercent } from '../utils/format.js'

/**
 * 「静默多久算掉线」的阈值。
 *
 * ⚠️ 这是**展示层的措辞分界**，不是任何口径：库里只存事件时刻，
 * 「掉线」必须由页面自己拿时间间隔去解释。取 24 小时是因为
 * 「一整个工作日没有任何上报」正好是运维会想去问一句的量级。
 */
export const SILENT_WARN_MS = 24 * 60 * 60 * 1000

/** 一行的静默档位：色调（给 tag / 状态行）+ 可读文案。 */
export interface SilenceVerdict {
  tone: 'green' | 'amber'
  text: string
}

/** 把「距今多少毫秒」翻成档位。`null` = 没有数据可判断，不参与告警。 */
export function silenceOf(ms: number | null, text: string): SilenceVerdict {
  if (ms === null) return { tone: 'green', text: '—' }
  return { tone: ms >= SILENT_WARN_MS ? 'amber' : 'green', text: text || '刚刚' }
}

/** 来源行 + 静默档位（表格与状态行共用同一份判定）。 */
export type SourceRowView = DiagnosticsSourceRow & { silence: SilenceVerdict }
export type ReporterRowView = DiagnosticsAttributionRow & { silence: SilenceVerdict }

/**
 * 状态行要显示什么。
 *
 * ⚠️ 顺序刻意固定：**未归属 > 来源静默 > 署名者静默**。
 *   未归属是「数据本身有问题」，永远比「某个客户端没在用」更该先说；
 *   而两个静默之间，来源维度更具体（能直接点名是哪个客户端）。
 */
export type DiagnosticConclusion =
  | { kind: 'unattributed'; count: number; tone: 'amber'; text: string }
  | { kind: 'silent-sources'; count: number; tone: 'amber'; text: string }
  | { kind: 'stale-reporters'; count: number; tone: 'amber'; text: string }
  | { kind: 'healthy'; count: 0; tone: 'green'; text: string }

/**
 * 收敛成一句可执行的结论。
 *
 * 🚨 「全部正常」必须要求**三种异常都不存在**。只判未归属就发绿，
 *   会让「某人三天没上报」在页面上显示成一路绿灯 —— 而那正是这一页
 *   要抓的东西（它与「数据漏了」在肉眼上毫无区别）。
 */
export function conclusionOf(
  unattributedEvents: number,
  sourceRows: readonly SourceRowView[],
  reporterRows: readonly ReporterRowView[],
): DiagnosticConclusion {
  if (unattributedEvents > 0)
    return {
      kind: 'unattributed',
      count: unattributedEvents,
      tone: 'amber',
      text: `存在 ${formatCount(unattributedEvents)} 条未归属记录`,
    }
  const silentSources = sourceRows.filter((row) => row.silence.tone === 'amber')
  if (silentSources.length)
    return {
      kind: 'silent-sources',
      count: silentSources.length,
      tone: 'amber',
      text: `${silentSources.length} 个采集来源已超过 24 小时没有新数据`,
    }
  const staleReporters = reporterRows.filter((row) => row.silence.tone === 'amber')
  if (staleReporters.length)
    return {
      kind: 'stale-reporters',
      count: staleReporters.length,
      tone: 'amber',
      text: `${staleReporters.length} 位署名者已超过 24 小时没有新数据`,
    }
  return {
    kind: 'healthy',
    count: 0,
    tone: 'green',
    text: '当前范围内未发现未归属记录，采集链路新鲜',
  }
}

/** 一张指标卡。`value` 已经格式化好（数字格式化只在 `utils/format.ts` 一处）。 */
export interface DiagnosticCard {
  key: string
  label: string
  title: string
  value: string
  unit: string
  tone: string
}

/** 只有这四张卡片依赖 v14 新增字段；服务端没返回时它们**整张消失**。 */
export const ENRICHED_CARD_KEYS: ReadonlySet<string> = new Set([
  'sessions',
  'tokens',
  'hit',
  'avg',
])

/**
 * 响应是不是「带 v14 字段的」那一版。
 *
 * 🚨 新旧服务端兼容的唯一判据：看**字段在不在**，不看数值大小。
 *   写成「值为 0 就不算新服务端」会让一个真实的 0 被当成旧服务端，
 *   于是「命中率恰好 0%」那一屏凭空少掉一张卡 —— 而那是一个合法的结果。
 */
export function isEnriched(
  d: Pick<DiagnosticsResponse, 'totalTokens'> | null | undefined,
): boolean {
  return !!d && typeof d.totalTokens === 'number'
}

/**
 * 指标卡集合。
 *
 * ⚠️ 旧服务端时那四张卡**消失**而不是显示 0：「查不到」与「真的是 0」
 *   在页面上长得一模一样，而前者是排障时要找的东西。
 */
export function diagnosticCards(d: DiagnosticsResponse | null): DiagnosticCard[] {
  const enriched = isEnriched(d)
  const warn = Boolean(d?.unattributedEvents)
  const cards: DiagnosticCard[] = [
    {
      key: 'events',
      label: '落库事件数',
      title: '当前范围内已经入库的计费事件',
      value: d ? formatCount(d.totalEvents) : '—',
      unit: '条',
      tone: 'violet',
    },
    {
      key: 'sessions',
      label: '会话数',
      // ⚠️ 会话数**不可加**（跨天会话会被算两次），所以它只来自去重查询，
      //   绝不能拿「每天的会话数求和」凑出来 —— 那会把数字说大。
      title: '范围内去重后的会话数量；跨天会话只计一次',
      value: d && enriched ? formatCount(d.sessions) : '—',
      unit: '条',
      tone: 'cyan',
    },
    {
      key: 'tokens',
      label: '计费总量',
      title: '未缓存输入 + 输出 + 缓存读 + 缓存写；库中不存该列，由四项派生',
      value: d && enriched ? formatCompact(d.totalTokens) : '—',
      unit: 'Token',
      tone: 'blue',
    },
    {
      key: 'hit',
      label: '缓存命中率',
      // 命中率低**不是采集故障**（它只说明提示词缓存没生效），
      // 所以绝不用警告色 —— 那一格的颜色在这一页专属于「数据可能漏了」。
      title: '缓存读取量占「缓存读取 + 未缓存输入」的比重；由服务端按统一口径算出',
      value: d && enriched ? formatPercent(d.cacheHitRate) : '—',
      unit: '',
      tone: 'green',
    },
    {
      key: 'users',
      label: '署名键组数',
      // ⚠️ 卡片名**刻意不叫**「分组数」：「分组」在产品里只有一个含义
      //   （人员分组实体，权威在 `member_group_assignments`）。本卡片数的是
      //   **署名键**的组数（每个稳定人员 + 每条待确认历史身份各算一组），
      //   与分组目录里的分组个数无关 —— 两者同名会让人拿看板数字去对
      //   分组管理页，然后把正确的数字当成数据 bug 排查。
      title: '人员与尚未关联成员的历史身份分别各计一组，不等同实际成员人数',
      value: d ? formatCount(d.distinctUsers) : '—',
      unit: '组',
      tone: 'blue',
    },
    {
      key: 'unattributed',
      label: '未署名事件',
      title: '未署名既不采集也不上报',
      value: d ? formatCount(d.unattributedEvents) : '—',
      unit: '条',
      tone: warn ? 'amber' : 'green',
    },
    {
      key: 'rate',
      label: '未署名占比',
      title: '未归属事件占当前范围全部事件的比重',
      value: d ? formatPercent(d.unattributedRate) : '—',
      unit: '',
      tone: warn ? 'amber' : 'green',
    },
    {
      key: 'avg',
      label: '每次调用均量',
      // ⚠️ 措辞刻意不写「平均消耗」：命中率高时这个数自然变大
      //   （一次长会话里连续几十次调用共享同一段缓存），
      //   中性话术会被读成「用得越来越费」。
      title: '计费总量 ÷ 调用次数，衡量单次调用的用量密度，不代表效率',
      value: d && enriched ? formatCount(Math.round(d.avgTokensPerCall)) : '—',
      unit: 'Token',
      tone: 'cyan',
    },
  ]
  return enriched ? cards : cards.filter((card) => !ENRICHED_CARD_KEYS.has(card.key))
}

/** 节奏卡片（数据跨度 / 平均每会话事件）。旧服务端整块不出现。 */
export interface CadenceCard {
  key: string
  label: string
  value: string
  hint: string
}

export function cadenceCards(d: DiagnosticsResponse | null): CadenceCard[] {
  // ⚠️ 判 `spanMs` 而不是 `totalTokens`：跨度是「最早到最晚」，
  //   没有事件时它是 null —— 而 null 才真的意味着「这块没有内容可画」。
  if (!d || typeof d.spanMs !== 'number') return []
  const cards: CadenceCard[] = [
    {
      key: 'span',
      label: '数据跨度',
      // ⚠️ 跨度取「最晚 − 最早」，**不是**筛选窗口的长度：
      //   客户端补报历史数据时事件时间可以远早于窗口，如实反映真实宽度才有诊断价值。
      value:
        d.spanMs === 0 ? '不足 1 天' : `${Math.max(1, Math.round(d.spanMs / 86_400_000))} 天`,
      hint: '最早事件到最新事件之间的真实时间宽度',
    },
  ]
  if (typeof d.eventsPerSession === 'number')
    cards.push({
      key: 'events-per-session',
      label: '平均每会话事件',
      value: formatCount(Math.round(d.eventsPerSession)),
      hint: '落库事件 ÷ 会话数；衡量一次会话被采集得多细',
    })
  return cards
}