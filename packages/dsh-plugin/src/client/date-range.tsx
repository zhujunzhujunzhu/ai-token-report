/** 中文范围日历。日期仅序列化为本地日历文本，统计时区与边界交给宿主。 */
import { useEffect, useId, useRef, useState } from 'react'
import { DayPicker, getDefaultClassNames, type DateRange } from 'react-day-picker'
import { zhCN } from 'react-day-picker/locale'
import { dayKey, fieldsToRange, parseDayText, selectionHint, triggerLabel, triggerTitle } from './date-text.js'
import type { UiDateRange } from './protocol.js'

const classNames = Object.fromEntries(Object.entries(getDefaultClassNames()).map(([key, value]) => [key, `atr-${value}`]))
const parseDay = (day: string) => new Date(`${day}T12:00:00`)
const monthStart = (day: string) => { const date = parseDay(day); return new Date(date.getFullYear(), date.getMonth(), 1) }
const nextMonth = (date: Date) => new Date(date.getFullYear(), date.getMonth() + 1, 1)

export function DateRangePicker(props: { range?: UiDateRange; active: boolean; disabled: boolean; onApply(range: UiDateRange): void }) {
  const [open, setOpen] = useState(false)
  /**
   * ★ 两个文本框是**唯一**的真实状态，日历的选区由它们推导。
   *
   * 之前是「日历 draft + 两行只读文本」：文本看起来像输入框却点不动，且日历与
   * 文本各存一份，谁覆盖谁的顺序变了就会不一致。现在打字、点日历都只改这两行字，
   * 没有可漂移的第二份状态。
   */
  const [fromText, setFromText] = useState('')
  const [toText, setToText] = useState('')
  const [months, setMonths] = useState(2)
  const [leftMonth, setLeftMonth] = useState(new Date())
  const [rightMonth, setRightMonth] = useState(new Date())
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const startInput = useRef<HTMLInputElement>(null)
  const id = useId()
  const hintId = `${id}-hint`

  useEffect(() => {
    const media = matchMedia('(max-width: 700px)')
    const update = () => setMonths(media.matches ? 1 : 2)
    update(); media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    // 打开就把光标放进「开始日期」：键盘使用者可以直接敲 2026-09-21，
    // 不必先 Tab 过一整个日历网格。
    startInput.current?.focus()
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  const close = () => { setOpen(false); trigger.current?.focus() }
  // 两行文本 → 日历选区 / 可应用区间。合法性只走 `parseDayText` + `validDateRange`。
  const sinceDay = parseDayText(fromText)
  const untilDay = parseDayText(toText)
  const range = fieldsToRange({ since: fromText, until: toText })
  const hint = selectionHint({ since: fromText, until: toText })
  /** 反向区间不能让日历画成「一条从大到小的带子」：只高亮开始日，并让提示说明原因。 */
  const inverted = sinceDay !== undefined && untilDay !== undefined && sinceDay > untilDay
  const draft: DateRange = {
    from: sinceDay === undefined ? undefined : parseDay(sinceDay),
    to: untilDay === undefined || inverted ? undefined : parseDay(untilDay),
  }
  const apply = () => { if (range !== undefined && !props.disabled) { props.onApply(range); close() } }

  /**
   * 两栏始终是**相邻且不同**的两个月。
   *
   * ⚠️ 之前两栏各跟各的输入框：两个日期落在同一个月时，两栏会同时显示那个月
   *   （看起来像同一张日历印了两遍）；区间反向时更糟，两栏都跳到结束日那一月。
   */
  const syncMonths = (from?: string, until?: string) => {
    const left = monthStart(from ?? until ?? dayKey(new Date()))
    const right = until !== undefined && monthStart(until).getTime() > left.getTime() ? monthStart(until) : nextMonth(left)
    setLeftMonth(left)
    setRightMonth(right)
  }

  /** 打字时把日历翻到那个月（否则「输入的日期在屏幕上根本看不见」）。 */
  const followMonth = (text: string, side: 'start' | 'end') => {
    const day = parseDayText(text)
    if (day === undefined) return
    const other = side === 'start' ? parseDayText(toText) : parseDayText(fromText)
    if (side === 'start') syncMonths(day, other)
    else syncMonths(other, day)
  }

  const openPicker = () => {
    if (open) { close(); return }
    setFromText(props.range?.since ?? '')
    setToText(props.range?.until ?? '')
    syncMonths(props.range?.since, props.range?.until)
    setOpen(true)
  }

  const field = (side: 'start' | 'end') => {
    const text = side === 'start' ? fromText : toText
    const setText = side === 'start' ? setFromText : setToText
    const parsed = parseDayText(text)
    const invalid = text.trim() !== '' && parsed === undefined
    return <label className="atr-calendar-field">
      <span>{side === 'start' ? '开始日期' : '结束日期'}</span>
      <input
        ref={side === 'start' ? startInput : undefined}
        type="text" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={10}
        className={invalid ? 'atr-calendar-input atr-calendar-input-invalid' : 'atr-calendar-input'}
        placeholder="YYYY-MM-DD" value={text} disabled={props.disabled}
        aria-label={side === 'start' ? '开始日期（YYYY-MM-DD）' : '结束日期（YYYY-MM-DD）'}
        aria-invalid={invalid} aria-describedby={hintId}
        onChange={event => { setText(event.target.value); followMonth(event.target.value, side) }}
        // 离开输入框时收敛成规范写法：`2026/10/8`、`2026年10月8日` 都变成 `2026-10-08`。
        onBlur={() => { if (parsed !== undefined && parsed !== text) setText(parsed) }}
      />
    </label>
  }

  return <div className="atr-date-picker" ref={root} onKeyDown={event => {
    if (!open) return
    if (event.key === 'Escape') { event.stopPropagation(); close(); return }
    if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') { event.preventDefault(); apply() }
  }}>
    <button type="button" ref={trigger} className="atr-btn atr-date-trigger" disabled={props.disabled}
      aria-expanded={open} aria-controls={id} aria-pressed={props.active}
      title={triggerTitle(props.range, props.active)} onClick={openPicker}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 11h18"/>
      </svg>
      {triggerLabel(props.range, props.active)}
      <svg className="atr-chevron" data-open={open} width="12" height="12" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m6 9 6 6 6-6"/>
      </svg>
    </button>
    {open && <section id={id} className="atr-calendar-popover" aria-label="选择日期范围">
      <div className="atr-calendar-heading">
        <strong>选择日期范围</strong>
        <span id={hintId} role="status" className={hint.error ? 'atr-calendar-hint atr-warn' : 'atr-calendar-hint'}>{hint.text}</span>
      </div>
      <div className="atr-calendar-selection">
        {field('start')}
        <span className="atr-calendar-arrow" aria-hidden="true">→</span>
        {field('end')}
      </div>
      {/* 两栏只共享选区，独立维护浏览月份，避免下拉年份和翻页互相牵动。 */}
      <div className="atr-calendar">{Array.from({ length: months }, (_, index) => <DayPicker key={index}
        mode="range" selected={draft}
        onSelect={next => { setFromText(next?.from ? dayKey(next.from) : ''); setToText(next?.to ? dayKey(next.to) : '') }}
        resetOnSelect required locale={zhCN} weekStartsOn={1} classNames={classNames}
        month={index === 0 ? leftMonth : rightMonth} onMonthChange={index === 0 ? setLeftMonth : setRightMonth}
        aria-label={index === 0 ? '左侧日历' : '右侧日历'}
        captionLayout="dropdown" startMonth={new Date(2000, 0)} endMonth={new Date(new Date().getFullYear() + 1, 11)}
        fixedWeeks showOutsideDays
        labels={{ labelNext: () => '下个月', labelPrevious: () => '上个月', labelMonthDropdown: () => '月份', labelYearDropdown: () => '年份' }}
      />)}</div>
      <div className="atr-calendar-footer"><span>按本地时区，包含起止两天</span><div>
        <button type="button" className="atr-btn" onClick={close}>取消</button>
        <button type="button" className="atr-btn atr-primary" disabled={range === undefined || props.disabled}
          onClick={apply}>应用范围</button>
      </div></div>
    </section>}
  </div>
}