/**
 * 用量面板的两个挂载点（浏览器半的 UI）。
 *
 * ## 挂在哪、为什么
 *
 * | 挂载点 | slot | 形态 |
 * |---|---|---|
 * | 输入框上方的常驻条 | `conversation.input.dock` | 一行摘要，点「详情」打开弹框 |
 * | 会话标题栏右侧的徽章 | `conversation.session.header.utilities` | 点开是一个浮层详情 |
 *
 * 这两个 slot 都是 `kind: 'list'`，都能被第三方插件注册 ——
 * 权威声明在 `@deepseek-ai/dsh-client-ui-conversation`
 * 的 `lib/types/client/contract/slots.d.ts`（`SlotMap` 声明合并）。
 * 与官方 GoalBar 用的是同一个挂载点，所以视觉上天然一致。
 *
 * ⚠️ **slot 名字写错不会报错**：`slots.inject(name, cb)` 只是「等这个 slot
 *   被声明出来」，名字不存在就永远不会回调，表现为**面板静默消失**。
 *   所以这两个名字在 `index.ts` 里被抽成常量并配了单测固定（见
 *   `test/client/slots.test.ts`），改动前先回去对一遍上面那份声明文件。
 *
 * ## 为什么不声明 locale 命名空间
 *
 * 第一方插件的文案走 `ctx.locale`（声明 `locale:` 后由框架注入 `t`）。
 *   本插件的受众是中文团队、文案量很小，硬编码中文可以省掉一个
 *   「locale 面没装上就渲染失败」的失败点 —— 官方文档明写声明了
 *   `locale:` 却在没有 locale 面的环境里渲染会**直接抛错**。
 */

import { SettingsPanel } from './settings.js'
import { Trend } from './chart.js'
import { DateRangePicker } from './date-range.js'
import { createPortal } from 'react-dom'

import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'

import {
  fmtCompact,
  fmtInt,
  fmtPct,
} from './format.js'
import { UI_PERIODS, UI_GROUP_BY, UI_PAGE_SIZE, type UiGroupBy, type UiGroupRow, type UiPeriod } from './protocol.js'
import type { UsageState, UsageStore } from './store.js'

/**
 * 订阅 store。两个挂载点共用，保证「同一份状态、只取一次数」。
 *
 * 第三个参数 `getServerSnapshot` 与第二个相同：浏览器里用不上，
 * 但**离屏渲染**（`react-dom/server` 的 `renderToStaticMarkup`）缺了它会直接抛
 * 「Missing getServerSnapshot」。本仓的渲染验证脚本正是走那条路
 * （见 `test/client/render.test.tsx`），所以这个参数是刻意的，不要删。
 */
function useUsage(store: UsageStore): UsageState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

/** 「未缓存输入」的口径说明 —— 鼠标停上去就能看到，防止被误读成「总输入」。 */
const INPUT_HINT = '未命中缓存的输入 token。缓存读的 94% 不在这里，在「缓存读」一列。'
const HIT_HINT = '缓存命中率 = cacheRead / (cacheRead + input)。分母不是 input。'

/** 周期切换按钮组。 */
function PeriodTabs(props: { period: UiPeriod; onPick: (p: UiPeriod) => void; disabled: boolean }): ReactNode {
  return createElement(
    'div',
    { className: 'atr-tabs atr-segmented', 'aria-label': '统计周期' },
    ...UI_PERIODS.filter(item => item.id !== 'custom').map((item) =>
      createElement(
        'button',
        {
          key: item.id,
          type: 'button',
          className: 'atr-btn',
          'aria-pressed': item.id === props.period,
          disabled: props.disabled,
          onClick: () => props.onPick(item.id),
        },
        item.label,
      ),
    ),
  )
}

/** 一个统计格子：大数用紧凑格式，精确值放 `title`。 */
function Cell(props: { label: string; value: number; hint?: string }): ReactNode {
  return createElement(
    'div',
    { className: 'atr-cell', title: props.hint ?? fmtInt(props.value) },
    createElement('span', { className: 'atr-cell-k' }, props.label),
    createElement('span', { className: 'atr-cell-v' }, fmtCompact(props.value)),
    createElement('span', { className: 'atr-cell-unit' }, 'tokens'),
  )
}

/** 一行排行。 */
function Row(props: { row: UiGroupRow }): ReactNode {
  const row = props.row
  return createElement('details', { className: 'atr-row-detail' },
    createElement('summary', { className: 'atr-row' },
      createElement('span', { className: 'atr-row-k', title: row.key }, row.key),
      createElement('span', { className: 'atr-row-n', title: fmtInt(row.total) }, fmtCompact(row.total)),
      createElement('span', { className: 'atr-row-n' }, fmtPct(row.cacheHitRate)),
      createElement('span', { className: 'atr-row-n' }, `${fmtInt(row.calls)} 次`)),
    createElement('div', { className: 'atr-breakdown' },
      ...([['未缓存输入', row.input], ['输出', row.output], ['缓存读', row.cacheRead],
        ['缓存写', row.cacheWrite], ['会话数', row.sessions]] as const).map(([label, value]) =>
        createElement('span', { key: label }, `${label}：${fmtInt(value)}`))))
}

const GROUP_LABELS: Record<string, string> = {
  'provider-model': '模型', provider: '服务商', project: '项目', session: '会话',
}

/** 详情体。输入框用量条和标题栏徽章打开的弹框共用。 */
export function UsageDetail(props: { state: UsageState; store: UsageStore; onClose?(): void }): ReactNode {
  const { state, store } = props
  const [settings, setSettings] = useState(false)
  const [localGroupBy, setGroupBy] = useState('provider-model')
  const [page, setPage] = useState(1)
  const remote = state.data?.view !== undefined
  const pagination = state.data?.pagination
  const groupBy = remote ? state.detail?.by ?? pagination?.by ?? 'provider-model' : localGroupBy
  const pageSize = pagination?.pageSize ?? UI_PAGE_SIZE
  useEffect(() => setPage(1), [groupBy, state.period, state.dateRange?.since, state.dateRange?.until])
  const rowCount = remote ? pagination?.totalRows ?? 0
    : state.data?.groups.find((group) => group.by === groupBy)?.rows.length
      ?? state.data?.groups[0]?.rows.length ?? 0
  const pageCount = Math.max(1, Math.ceil(rowCount / pageSize))
  const currentPage = remote ? pagination?.page ?? 1 : Math.min(page, pageCount)
  useEffect(() => setPage((previous) => Math.min(previous, pageCount)), [pageCount])
  const [trendMetric, setTrendMetric] = useState<'total' | 'calls' | 'cacheHitRate'>('total')
  const data = state.data
  /**
   * ★ 只把**首次加载**算作「挡住使用者」，后台刷新不算。
   *
   * 之前是 `loading || refreshing`，于是每次轮询一发起就把周期页签、日期选择器、
   * 刷新按钮全部 `disabled` —— 面板每隔几秒「抽一下」，刷新按钮还会把点击吞掉。
   * 后台刷新期间本来就可以继续操作：新的请求会按序号覆盖旧的（见 store.ts）。
   */
  const blocked = state.loading
  const busy = state.loading || state.refreshing

  const head = createElement(
    'div',
    { className: 'atr-page-head' },
    createElement('div', { className: 'atr-heading' },
      createElement('div', null,
        createElement('span', { className: 'atr-eyebrow' }, '用量概览'),
        createElement('h2', { className: 'atr-title' }, 'DSH token 用量'),
        createElement('span', { className: 'atr-range', role: 'status' },
          data?.rangeLabel ?? '正在读取统计…', state.refreshing ? ' · 正在更新…' : '')),
      createElement('div', { className: 'atr-heading-actions' },
        props.onClose ? createElement('button', { type: 'button', className: 'atr-btn atr-close', onClick: props.onClose, 'aria-label': '关闭用量详情' }, '×') : null)),
    !settings ? createElement('div', { className: 'atr-filter-bar' },
    createElement(PeriodTabs, {
      period: state.period, onPick: store.setPeriod, disabled: blocked,
    }),
    createElement(DateRangePicker, { range: state.dateRange, active: state.period === 'custom', disabled: blocked, onApply: store.setCustomRange }),
    createElement('div', { className: 'atr-filter-actions' },
    createElement(
      'button',
      { type: 'button', className: 'atr-btn atr-icon-btn atr-refresh', onClick: store.refresh, disabled: blocked, title: busy ? '正在刷新' : '刷新用量', 'aria-label': '刷新用量', 'aria-busy': busy },
      createElement('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        createElement('path', { d: 'M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 19.5 9M4.5 15a8 8 0 0 0 13.4 2.9' })),
    ),
    createElement('button', { type: 'button', className: 'atr-btn atr-icon-btn atr-settings-btn', onClick: () => setSettings(true), title: '署名与上报配置', 'aria-label': '配置' },
      createElement('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        createElement('path', { d: 'M9.5 3h5l.6 2.5 1.3.8 2.5-.7 2.5 4.3-1.9 1.8v1.6l1.9 1.8-2.5 4.3-2.5-.7-1.3.8-.6 2.5h-5l-.6-2.5-1.3-.8-2.5.7-2.5-4.3 1.9-1.8v-1.6L2.6 9.9l2.5-4.3 2.5.7 1.3-.8L9.5 3Z' }),
        createElement('circle', { cx: 12, cy: 12.5, r: 3 }))),
    )) : null,
  )

  if (settings) return createElement('div', { className: 'atr-card' }, head,
    createElement('div', { className: 'atr-body' }, createElement(SettingsPanel, { onClose: () => setSettings(false) })))

  // 还没有任何数据：首次统计在 Node 宿主上是**真扫描**，可能十几秒。
  // 这里必须说出来，否则用户会以为面板坏了。
  if (data === undefined) {
    return createElement(
      'div',
      { className: 'atr-card' },
      head,
      createElement('div', { className: 'atr-body' }, state.error !== undefined
        ? createElement('div', { className: 'atr-metrics atr-warn' }, state.error)
        : createElement(
            'div',
            { className: 'atr-empty' },
            '正在统计本机会话日志…首次建立索引可能要十几秒，之后只增量更新变化的日志并查询 SQLite。',
          )),
    )
  }

  const t = data.totals
  const m = data.metrics
  const topGroup = data.groups.find((group) => group.by === groupBy) ?? data.groups[0]
  const series = data.series ?? []
  const detailPending = data.view === 'summary'
  const pickGroup = (by: string): void => {
    if (remote) store.setDetail(by as UiGroupBy)
    else setGroupBy(by)
  }
  const pickPage = (next: number): void => {
    if (remote) store.setDetail(groupBy as UiGroupBy, next)
    else setPage(next)
  }
  const visibleRows = remote ? topGroup?.rows
    : topGroup?.rows.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  return createElement(
    'div',
    { className: 'atr-card', 'aria-busy': busy },
    head,
    createElement('div', { className: 'atr-body' },
    createElement(
      'div',
      { className: 'atr-cells' },
      createElement(Cell, { label: '计费总量', value: t.total, hint: `${fmtInt(t.total)} = input + output + cacheRead + cacheWrite` }),
      createElement(Cell, { label: '未缓存输入', value: t.input, hint: INPUT_HINT }),
      createElement(Cell, { label: '输出', value: t.output, hint: '模型生成的输出 token' }),
      createElement(Cell, { label: '缓存读', value: t.cacheRead, hint: '命中缓存读取的 token。实测占总用量 94.3%。' }),
    ),

    createElement(
      'div',
      { className: 'atr-metrics' },
      createElement('span', { title: HIT_HINT }, '缓存命中率 ', createElement('b', null, fmtPct(m.cacheHitRate))),
      createElement('span', null, '平均每次 ', createElement('b', null, fmtCompact(m.avgTokensPerCall))),
      createElement('span', null, '调用 ', createElement('b', null, fmtInt(t.calls))),
      createElement('span', null, '会话 ', createElement('b', null, fmtInt(data.sessions))),
      t.cacheWrite > 0 ? createElement('span', null, '缓存写 ', createElement('b', null, fmtCompact(t.cacheWrite))) : null,
    ),

    createElement('section', { className: 'atr-section' },
      createElement('div', { className: 'atr-head' }, createElement('div', null,
        createElement('strong', { className: 'atr-section-title' }, '用量趋势'),
        createElement('span', { className: 'atr-section-note' }, '查看各时段的用量变化')),
        createElement('span', { className: 'atr-grow' }),
        createElement('div', { className: 'atr-tabs atr-segmented' },
        ...(['total', 'calls', 'cacheHitRate'] as const).map((metric) => createElement('button', {
          key: metric, type: 'button', className: 'atr-btn', 'aria-pressed': metric === trendMetric,
          onClick: () => setTrendMetric(metric),
        }, { total: 'Token 总量', calls: '调用数', cacheHitRate: '命中率' }[metric])))),
      series.length > 0 ? createElement(Trend, { series, metric: trendMetric }) : createElement('div', { className: 'atr-chart atr-chart-empty' }, detailPending ? '正在读取趋势…' : '暂无趋势数据')),

    createElement('section', { className: 'atr-section atr-detail-section' },
    createElement('div', { className: 'atr-head' },
      createElement('strong', { className: 'atr-section-title' }, '用量明细'),
      createElement('span', { className: 'atr-grow' }),
    createElement('div', { className: 'atr-tabs atr-segmented', role: 'tablist', 'aria-label': '明细分组' },
      ...(remote ? UI_GROUP_BY : data.groups.map(group => group.by)).map((by) => createElement('button', {
        key: by, type: 'button', role: 'tab', className: 'atr-btn',
        'aria-selected': by === (topGroup?.by ?? groupBy), 'aria-pressed': by === (topGroup?.by ?? groupBy),
        onClick: () => pickGroup(by),
      }, GROUP_LABELS[by] ?? by)))),
    createElement('div', { className: 'atr-row atr-table-head' },
      ...['明细（点击展开）', 'Token 总量', '命中率', '调用数'].map((label) => createElement('span', { key: label }, label))),

    topGroup !== undefined && topGroup.rows.length > 0
      ? createElement(
          'div',
          { className: 'atr-rows' },
          ...(visibleRows ?? []).map((row) => createElement(Row, { key: `${topGroup.by}:${row.key}`, row })),
        )
      : createElement('div', { className: 'atr-empty' }, detailPending ? '正在读取用量明细…' : `${data.rangeLabel}没有计费事件。`),
    pageCount > 1 ? createElement('nav', { className: 'atr-pagination', 'aria-label': '用量明细分页' },
      createElement('span', { className: 'atr-page-summary', role: 'status' },
        `共 ${fmtInt(rowCount)} 条 · 第 ${(currentPage - 1) * pageSize + 1}–${Math.min(currentPage * pageSize, rowCount)} 条`),
      createElement('button', { type: 'button', className: 'atr-btn', disabled: currentPage === 1 || (remote && busy), onClick: () => pickPage(currentPage - 1) }, '上一页'),
      createElement('span', null, `${currentPage} / ${pageCount}`),
      createElement('button', { type: 'button', className: 'atr-btn', disabled: currentPage === pageCount || (remote && busy), onClick: () => pickPage(currentPage + 1) }, '下一页')) : null),

    // 刷新失败时旧数据仍然显示，但必须把失败讲出来
    state.error !== undefined ? createElement('div', { className: 'atr-warn', role: 'alert' }, `更新失败，仍显示「${data.rangeLabel}」的数据：${state.error}`) : null,
    data.degradedReason !== undefined ? createElement('div', { className: 'atr-warn', role: 'status' }, data.degradedReason) : null),
  )
}

/** 输入框上方的常驻用量条（`conversation.input.dock`）。 */
export function UsageDock(props: { usage: UsageStore }): ReactNode {
  const store = props.usage
  const state = useUsage(store)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const data = state.data

  return createElement(
    'div',
    null,
    createElement(
      'div',
      { className: 'atr-strip' },
      createElement('span', { className: 'atr-strip-label' }, 'TOKEN 用量'),
      createElement(
        'span',
        { className: 'atr-strip-period' },
        data?.rangeLabel ?? UI_PERIODS.find((p) => p.id === state.period)?.label ?? state.period,
      ),
      createElement(
        'div',
        { className: 'atr-strip-metrics' },
        data === undefined
          ? createElement(
              'span',
              { className: state.error !== undefined ? 'atr-warn' : 'atr-empty' },
              state.error ?? '统计中…',
            )
          : createElement(
              'span',
              { className: 'atr-strip-total', title: fmtInt(data.totals.total) },
              fmtCompact(data.totals.total),
              createElement('span', { className: 'atr-strip-unit' }, ' tokens'),
            ),
        data !== undefined
          ? createElement('span', { title: HIT_HINT }, `命中率 ${fmtPct(data.metrics.cacheHitRate)}`)
          : null,
        data !== undefined ? createElement('span', null, `${fmtInt(data.totals.calls)} 次调用`) : null,
        data !== undefined && data.degradedReason !== undefined ? createElement('span', { className: 'atr-warn' }, '已降级') : null,
      ),
      createElement(
        'div',
        { className: 'atr-strip-actions' },
        createElement(
          'button',
          {
            type: 'button',
            className: 'atr-btn',
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            onClick: () => setOpen(true),
          },
          '详情',
        ),
      ),
    ),
    open ? createElement(UsageDialog, { state, store, onClose: close }) : null,
  )
}

/** 会话标题栏右侧的紧凑徽章（`conversation.session.header.utilities`）。 */
export function UsageBadge(props: { usage: UsageStore }): ReactNode {
  const store = props.usage
  const state = useUsage(store)
  const [open, setOpen] = useState(false)
  const data = state.data
  const close = useCallback(() => setOpen(false), [])

  const warn = state.error !== undefined

  return createElement(
    'div',
    null,
    createElement(
      'button',
      {
        type: 'button',
        className: 'atr-badge',
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        onClick: () => setOpen((v) => !v),
        title: warn ? state.error : 'DSH token 用量（点开看详情）',
      },
      createElement('span', { className: warn ? 'atr-badge-dot atr-badge-dot-warn' : 'atr-badge-dot' }),
      data === undefined ? 'TOKEN' : fmtCompact(data.totals.total),
      data !== undefined ? createElement('span', null, fmtPct(data.metrics.cacheHitRate)) : null,
    ),
    open ? createElement(UsageDialog, { state, store, onClose: close }) : null,
  )
}

/** 两个入口共用弹框；挂到 body，避免输入框容器的裁剪与 transform 限制浮层。 */
function UsageDialog(props: { state: UsageState; store: UsageStore; onClose(): void }): ReactNode {
  const { state, store, onClose } = props
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => store.acquireDetails(), [store])
  useEffect(() => {
    const previous = globalThis.document.activeElement as HTMLElement | null
    const focusable = (): HTMLElement[] => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
    ) ?? [])
    focusable()[0]?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
      if (event.key !== 'Tab') return
      const elements = focusable()
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (event.shiftKey && globalThis.document.activeElement === first) {
        event.preventDefault(); last?.focus()
      } else if (!event.shiftKey && globalThis.document.activeElement === last) {
        event.preventDefault(); first?.focus()
      }
    }
    globalThis.document.addEventListener('keydown', onKey)
    return () => {
      globalThis.document.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [onClose])

  return createPortal(
    createElement('div', { className: 'atr-mask', onClick: onClose },
      createElement('div', {
        className: 'atr-dialog', ref: dialogRef, role: 'dialog', 'aria-modal': true,
        'aria-label': 'DSH token 用量', onClick: (event: { stopPropagation(): void }) => event.stopPropagation(),
      },
      createElement(UsageDetail, { state, store, onClose }))),
    globalThis.document.body,
  )
}
