/** 中文范围日历。日期仅序列化为本地日历文本，统计时区与边界交给宿主。 */
import { useEffect, useId, useRef, useState } from 'react'
import { DayPicker, getDefaultClassNames, type DateRange } from 'react-day-picker'
import { zhCN } from 'react-day-picker/locale'
import { validDateRange, type UiDateRange } from './protocol.js'

const classNames = Object.fromEntries(Object.entries(getDefaultClassNames()).map(([key, value]) => [key, `atr-${value}`]))
const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const parseDay = (day: string) => new Date(`${day}T12:00:00`)

export function DateRangePicker(props: { range?: UiDateRange; active: boolean; disabled: boolean; onApply(range: UiDateRange): void }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<DateRange>()
  const [months, setMonths] = useState(2)
  const [leftMonth, setLeftMonth] = useState(new Date())
  const [rightMonth, setRightMonth] = useState(new Date())
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
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
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])
  const close = () => { setOpen(false); trigger.current?.focus() }
  const range = draft?.from && draft.to ? { since: dayKey(draft.from), until: dayKey(draft.to) } : undefined
  return <div className="atr-date-picker" ref={root} onKeyDown={event => {
    if (open && event.key === 'Escape') { event.stopPropagation(); close() }
  }}>
    <button type="button" ref={trigger} className="atr-btn atr-date-trigger" disabled={props.disabled}
      aria-expanded={open} aria-controls={id} aria-pressed={props.active}
      onClick={() => {
        if (open) { close(); return }
        setDraft(props.range ? { from: parseDay(props.range.since), to: parseDay(props.range.until) } : undefined)
        const start = props.range ? parseDay(props.range.since) : new Date()
        const end = props.range ? parseDay(props.range.until) : start
        setLeftMonth(new Date(start.getFullYear(), start.getMonth(), 1))
        setRightMonth(end.getFullYear() === start.getFullYear() && end.getMonth() === start.getMonth()
          ? new Date(start.getFullYear(), start.getMonth() + 1, 1)
          : new Date(end.getFullYear(), end.getMonth(), 1))
        setOpen(true)
      }}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 11h18"/>
      </svg>
      自定义<span aria-hidden="true">⌄</span>
    </button>
    {open && <section id={id} className="atr-calendar-popover" aria-label="选择日期范围">
      <div className="atr-calendar-heading"><strong>选择日期范围</strong><span>先选开始，再选结束</span></div>
      <div className="atr-calendar-selection" aria-live="polite">
        <div><span>开始日期</span><strong>{draft?.from ? dayKey(draft.from) : '请选择'}</strong></div>
        <span aria-hidden="true">→</span>
        <div><span>结束日期</span><strong>{draft?.to ? dayKey(draft.to) : '请选择'}</strong></div>
      </div>
      {/* 两栏只共享选区，独立维护浏览月份，避免下拉年份和翻页互相牵动。 */}
      <div className="atr-calendar">{Array.from({ length: months }, (_, index) => <DayPicker key={index}
        mode="range" selected={draft} onSelect={setDraft}
        resetOnSelect required locale={zhCN} weekStartsOn={1} classNames={classNames}
        month={index === 0 ? leftMonth : rightMonth} onMonthChange={index === 0 ? setLeftMonth : setRightMonth}
        autoFocus={index === 0} aria-label={index === 0 ? '左侧日历' : '右侧日历'}
        captionLayout="dropdown" startMonth={new Date(2000, 0)} endMonth={new Date(new Date().getFullYear() + 1, 11)}
        fixedWeeks showOutsideDays
        labels={{ labelNext: () => '下个月', labelPrevious: () => '上个月', labelMonthDropdown: () => '月份', labelYearDropdown: () => '年份' }}
      />)}</div>
      <div className="atr-calendar-footer"><span>按本地时区，包含起止两天</span><div>
        <button type="button" className="atr-btn" onClick={close}>取消</button>
        <button type="button" className="atr-btn atr-primary" disabled={!validDateRange(range) || props.disabled}
          onClick={() => { if (range && validDateRange(range)) { props.onApply(range); close() } }}>应用范围</button>
      </div></div>
    </section>}
  </div>
}
