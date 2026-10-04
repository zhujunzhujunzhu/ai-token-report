/**
 * `--cost` 的展示层：JSON 载荷、CSV 分节、终端小节。
 *
 * ## 🚨 这里绝不出现任何金额算术
 *
 * 四类分价相乘、按币种分桶、未配价比例**全部**由 `@ai-token-report/core/db` 的
 * `costTotalsOf()` / `costByGroupOf()` 算完之后交进来；本文件只做排版，金额一律经
 * `@ai-token-report/shared` 的 `formatCostSummary()`（多币种用 ` + ` 连接）。
 * 在这里写一遍 `amountMicro / 1e6` 或跨币种相加，就等于造出第二个口径 ——
 * 它不会报错，只会让 CLI 与看板的同一笔钱悄悄对不上，而两边都「看起来正常」。
 *
 * ## 未计价绝不渲染成 0
 *
 * `formatCostSummary([])` 返回 `null`（不是 `$0.00`），本文件把它译成「未计价」；
 * CSV 里未计价的用量**不写进金额节**，而是单列一节 —— 一行 `amountMicro = 0`
 * 与「这条用量真的不花钱」在机器读来完全一样，那是本模块最危险的误读。
 */

import {
  fmtInt,
  fmtPct,
  fmtTime,
  renderTable,
  toCsv,
  type GroupDimension,
  type GroupRow,
} from '@ai-token-report/core'
import type { CostTotals, CostTotalsWithTargets, LocalPricing } from '@ai-token-report/core/db'
import { MAX_UNPRICED_TARGETS } from '@ai-token-report/core/db'
import { formatCostSummary, type PricingProvenance } from '@ai-token-report/shared'

/**
 * 一次 `--cost` 的全部中间结果。
 *
 * ★ `pricing` 必须一路带到展示层：同一次查询在「读快照」与「读不到价（`'none'`）」
 *   下会给出**两个不同的结果**（前者有金额，后者一位金额都不显示），
 *   而两者都看起来正常。展示层不写清「这笔钱是按哪份价算的」，使用者就只能拿着它与看板对账。
 */
export interface CostView {
  pricing: LocalPricing
  /** 当前过滤条件下的整体金额 + 未配价清单。 */
  totals: CostTotalsWithTargets
  /** `--by` 每个维度 → 分组键 → 该组的费用。 */
  groups: Map<GroupDimension, Map<string, CostTotals>>
}

/** 单价来源的人话描述。 */
export function describeProvenance(provenance: PricingProvenance): string {
  switch (provenance.pricingSource) {
    case 'snapshot': {
      const at = provenance.pricingSyncedAt
      return at === null
        ? '本地单价快照（同步时间未知）'
        : `本地单价快照（同步于 ${fmtTime(at)}）`
    }
    case 'none':
      // 2026-10 起不再有内置种子价兜底：读不到可用单价就是**没有价**，一位金额都不显示。
      // 措辞要让人立刻明白「不是 0 元，是没配上价」（原因由 `pricing.note` 原样带出）。
      return '未配单价（没有可用的单价，不显示金额）'
    case 'db':
      // 离线路径不该出现，但列出来是为了「不认识就报错」而不是静默显示成别的来源。
      return '部门服务端数据库单价'
  }
}

/** 该组的金额文本；一条价都没配上时给「未计价」而不是 `¥0.00`。 */
function amountText(totals: CostTotals): string {
  return formatCostSummary(totals.costs) ?? '未计价'
}

/**
 * 按**排行表的顺序**列出费用键。
 *
 * ★ 顺序取自 `session.groups(dim)`（已按总量降序），不取费用 map 的插入序：
 *   插入序是「记录出现顺序」，与排行表不同，而 `--top N` 一裁，两张表展示的
 *   就不再是同一批键 —— 费用表与排行表挨着看时，这种错位会被读成「少算了一个供应商」。
 * ★ 排行表里没有、费用表里有的键**追加在后面**：那只可能出现在分组口径分叉的时候，
 *   但「钱不见了」比「多打一行」严重得多，所以宁可多打一行。
 */
export function orderedCostKeys(
  groupRows: readonly GroupRow[] | undefined,
  costs: Map<string, CostTotals>,
): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const row of groupRows ?? []) {
    if (seen.has(row.key)) continue
    seen.add(row.key)
    keys.push(row.key)
  }
  return [...keys, ...[...costs.keys()].filter((key) => !seen.has(key)).sort()]
}

function topKeys(keys: readonly string[], top: number): string[] {
  return top > 0 ? keys.slice(0, top) : [...keys]
}

/** 未配价清单的展示后缀：到达上限时明说可能还有更多。 */
function targetSuffix(targets: readonly string[]): string {
  return targets.length >= MAX_UNPRICED_TARGETS
    ? `（最多列出 ${MAX_UNPRICED_TARGETS} 个，可能还有更多）`
    : ''
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * `--cost` 的 JSON 片段。
 *
 * ⚠️ 整个 `cost` 键**只在 `--cost` 时出现**（调用方用条件展开），不在时连空对象都没有：
 *   「字段缺席」与「金额为 0」必须是两件事，JSON 消费方靠这个区分「没算」与「算了是 0」。
 * ★ `groups` 里同时给 `pricedRate` 与 `unpricedRate`：只给一个的话，消费方会自己写
 *   `1 - unpricedRate` —— 那就是第二处口径实现。
 */
export function costJsonPayload(
  view: CostView,
  dims: readonly GroupDimension[],
  grouped: Map<GroupDimension, GroupRow[]>,
): Record<string, unknown> {
  const groups: Record<string, unknown> = {}
  for (const dim of dims) {
    const costs = view.groups.get(dim) ?? new Map<string, CostTotals>()
    const entry: Record<string, unknown> = {}
    for (const key of orderedCostKeys(grouped.get(dim), costs)) {
      const totals = costs.get(key)
      if (!totals) continue
      entry[key] = {
        costs: totals.costs,
        pricedTokens: totals.pricedTokens,
        unpricedTokens: totals.unpricedTokens,
        totalTokens: totals.totalTokens,
        pricedRate: totals.pricedRate,
        unpricedRate: totals.unpricedRate,
      }
    }
    groups[dim] = entry
  }
  // `pricing` 提到顶层、且**从 totals 里摘掉**：同一份事实给两遍，两份迟早会分叉。
  const { pricing: _provenance, ...totals } = view.totals
  return { pricing: view.pricing.provenance, totals, groups }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * `--cost` 的 CSV 分节（三节，各自带真实表头）。
 *
 * ## 为什么未计价单独一节，而不是在金额节里给一行 `amountMicro = 0`
 *
 * `0` 在金额列里只有一个意思：**这条用量不花钱**。未计价的含义恰好相反 ——
 * 「我们不知道它花多少」。两者写成一个值，任何脚本都会把「漏配价」读成「免费」，
 * 而这正是费用统计里最危险的误读。所以：
 *
 * | 节 | 内容 | 缺席的含义 |
 * |---|---|---|
 * | `# cost` | 只有**真的算出了金额**的行（整数微元） | 该键一条价都没配上 |
 * | `# cost-unpriced` | 明确列出未计价的 token 数 | 该键没有未计价用量 |
 * | `# cost-meta` | 这份金额是按哪份价算的 + **全局**合计与比例 | 恒有一行 |
 *
 * ★ `# cost-meta` 里的全局比例不能靠消费方从上面两节相加得到：`--top` 会截断行，
 *   截断后的和既不是总量、也没有任何标记说明它被截断了。
 * ★ 逐币种的**全局**金额刻意不在这里给（矩形表里塞不下「每币种一行 + 一行汇总」）：
 *   需要它的消费方用 `--format json`，那里的 `totals.costs` 是同一个形状。
 */
export function costCsvSections(
  view: CostView,
  dims: readonly GroupDimension[],
  grouped: Map<GroupDimension, GroupRow[]>,
  top: number,
): string[] {
  const amountRows: (string | number)[][] = []
  const unpricedRows: (string | number)[][] = []
  for (const dim of dims) {
    const costs = view.groups.get(dim) ?? new Map<string, CostTotals>()
    for (const key of topKeys(orderedCostKeys(grouped.get(dim), costs), top)) {
      const totals = costs.get(key)
      if (!totals) continue
      for (const bucket of totals.costs) {
        amountRows.push([dim, key, bucket.currency, bucket.amountMicro, bucket.tokens])
      }
      if (totals.unpricedTokens > 0) {
        unpricedRows.push([
          dim,
          key,
          totals.unpricedTokens,
          totals.totalTokens,
          totals.unpricedRate.toFixed(6),
        ])
      }
    }
  }

  const provenance = view.pricing.provenance
  return [
    '',
    `# cost (单价来源: ${describeProvenance(provenance)})`,
    toCsv(
      ['dimension', 'key', 'currency', 'amountMicro', 'tokens'],
      amountRows,
    ),
    '',
    '# cost-unpriced (这些 token 一条价都没配上 = 未计价, 不是 0 元)',
    toCsv(
      ['dimension', 'key', 'unpricedTokens', 'totalTokens', 'unpricedRate'],
      unpricedRows,
    ),
    '',
    '# cost-meta (本次计价的来源与全局合计, 与 --top 无关; 逐币种全局金额见 --format json)',
    toCsv(
      [
        'pricingSource',
        'pricingSyncedAt',
        'pricedTokens',
        'unpricedTokens',
        'totalTokens',
        'pricedRate',
        'unpricedRate',
        'note',
      ],
      [[
        provenance.pricingSource,
        provenance.pricingSyncedAt === null ? '' : new Date(provenance.pricingSyncedAt).toISOString(),
        view.totals.pricedTokens,
        view.totals.unpricedTokens,
        view.totals.totalTokens,
        view.totals.pricedRate.toFixed(6),
        view.totals.unpricedRate.toFixed(6),
        view.pricing.note ?? '',
      ]],
    ),
  ]
}

// ---------------------------------------------------------------------------
// 终端
// ---------------------------------------------------------------------------

/**
 * `--cost` 的终端小节。
 *
 * ★ 读不到可用单价（`pricing.note !== null`）时把原因**原样**打出来：没有快照 / 快照坏了 /
 *   快照里一条价都没有，三种情况都不显示金额。不告警的话，使用者会拿一个空金额去对账。
 * ★ 表格用 `renderTable()` 而不是 `padEnd()`：分组键里有中文（项目名、按天）时
 *   `padEnd` 会按字符数补齐，金额列在中文行上整体错位。
 * ★ 维度标题由调用方给（`labelOf`）：中文标签只有一份（`cli.ts` 的 `dimLabel()`），
 *   在这里再抄一张表就是第二份「哪个维度叫什么」，而它必然与排行表漂移。
 */
export function renderCostSection(
  view: CostView,
  dims: readonly GroupDimension[],
  grouped: Map<GroupDimension, GroupRow[]>,
  top: number,
  labelOf: (dim: GroupDimension) => string,
): string {
  const out: string[] = ['', '=== 费用（估算） ===']

  const header: string[] = [`单价来源: ${describeProvenance(view.pricing.provenance)}`]
  // 未计价为 0 时这一项不显示：0% 是一句废话，而它会把真正要看的数字挤到后面。
  if (view.totals.unpricedTokens > 0) {
    header.push(`未计价 ${fmtPct(view.totals.unpricedRate)}（${fmtInt(view.totals.unpricedTokens)} Token）`)
  }
  out.push(header.join('  '))
  if (view.pricing.note !== null) out.push(`⚠ ${view.pricing.note}`)
  if (view.totals.unpricedTargets.length > 0) {
    out.push(`未配单价: ${view.totals.unpricedTargets.join('、')}${targetSuffix(view.totals.unpricedTargets)}`)
  }
  // 合计：把每个 `--by` 维度各自加起来的数（多币种用 ` + ` 连接，绝不相加）。
  out.push(`合计: ${amountText(view.totals)}`)

  for (const dim of dims) {
    const costs = view.groups.get(dim) ?? new Map<string, CostTotals>()
    const all = orderedCostKeys(grouped.get(dim), costs)
    const shown = topKeys(all, top)
    const suffix = top > 0 && all.length > top ? `（共 ${all.length} 组，显示前 ${top}）` : ''
    out.push(`${labelOf(dim)}${suffix}`)
    const rows = shown
      .map((key) => {
        const totals = costs.get(key)
        return totals ? [key, amountText(totals)] : null
      })
      .filter((row): row is string[] => row !== null)
    if (rows.length === 0) {
      out.push('  （本维度没有可显示的分组）')
      continue
    }
    out.push(
      renderTable(
        [
          { title: '分组键', align: 'left' },
          { title: '费用（估算）', align: 'right' },
        ],
        rows,
      ),
    )
  }
  return out.join('\n')
}