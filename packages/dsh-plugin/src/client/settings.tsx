/**
 * 插件设置页 —— **四件事：服务端地址、appKey、上报间隔、面板位置**，
 * 外加一个「上报调试」页签（看刚刚发出去了什么，见 `report-debug.tsx`）。
 *
 * ## 为什么只有这四个字段（外加一个调试页）
 *
 * 员工手上真正拿到的东西只有两样：部门平台的地址，和管理员发的一串 appKey。
 * 其余全部是派生的：
 *
 * | 面板字段 | 从哪来 |
 * |---|---|
 * | 姓名 / 分组 | ★ **服务端校验结果**，不是用户填的 |
 * | 上报地址 `/api/v1/token-usage` | `baseUrl` + 固定路径 |
 * | 校验地址 `/api/v1/identity/verify` | 同上 |
 *
 * 旧版面板让用户分别填「姓名 / 身份 Key / 完整上报地址 / appKey」——
 * 四栏里有两栏是同一个意思（身份 Key 与 appKey 都只是凭证），
 * 还有一栏要求用户自己拼出完整接口路径。实测用户会把 API base URL 填进
 * 「姓名」，而真正该填的 appKey 栏空着。
 *
 * ## ★ 保存后立刻生效
 *
 * 保存成功后宿主会**就地**换连接（不必重启 DSH），并把 `reporting`
 * （上报中 / 未上报及原因）回给页面。所以这里如实显示：
 * 「已保存并开始上报 → 地址」。位置由 `position.ts` 的总线就地切换。
 *
 * ## 凭证只提交、不回显
 *
 * GET 只回「填没填」（`hasAppKey`），appKey 绝不发回浏览器；
 * 保存成功后立刻清空输入框。浏览器存储（localStorage / cookie）里也不留一份。
 *
 * ## 「只改偏好」不必重新校验 appKey
 *
 * 已经配好的人改间隔/位置时不该被要求再粘一次密钥（那串东西往往已经不在手边）。
 * 因此当 appKey 留空且地址没变时，宿主只更新本机偏好、不重校验、不重写身份文件。
 */
import { createElement as h, useEffect, useState, type ReactNode, type FormEvent } from 'react'
import {
  UI_DEFAULT_FLUSH_INTERVAL_MILLIS,
  UI_FLUSH_INTERVALS,
  UI_SETTINGS_PATH,
  readUiSettings,
  type UiPosition,
  type UiReportingStatus,
  type UiSettingsPayload,
} from './protocol.js'
import { applyPosition } from './position.js'
import { ReportDebugPanel } from './report-debug.js'

/** 位置的用户可读说法。`dock` 是默认值，所以文案里说明「默认」。 */
const POSITION_LABELS: Record<UiPosition, string> = {
  dock: '输入框上方（用量条，默认）',
  header: '会话标题栏右上角（胶囊）',
  both: '两处都显示（旧版外观）',
}

/** 间隔的可读说法（后端值 → 文案）。 */
export function intervalLabel(millis: number): string {
  if (millis % 60_000 === 0) return `${millis / 60_000} 分钟`
  return `${millis / 1_000} 秒`
}

type Tab = 'connection' | 'debug'

export function SettingsPanel(props: { onClose(): void }): ReactNode {
  const [loaded, setLoaded] = useState<UiSettingsPayload | undefined>(undefined)
  const [refreshError, setRefreshError] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [appKey, setAppKey] = useState('')
  const [interval, setInterval] = useState(UI_DEFAULT_FLUSH_INTERVAL_MILLIS)
  const [position, setPosition] = useState<UiPosition>('dock')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<Tab>('connection')
  /** 保存后宿主回报的上报状态（比 GET 那一刻的更新）。 */
  const [live, setLive] = useState<UiReportingStatus | undefined>(undefined)

  useEffect(() => {
    const controller = new AbortController()
    void fetch(UI_SETTINGS_PATH, { signal: controller.signal }).then(async (res) => {
      if (!res.ok) throw new Error(`配置读取失败（HTTP ${res.status}）`)
      const body = readUiSettings(await res.json().catch(() => undefined))
      if (controller.signal.aborted) return
      setLoaded(body)
      setBaseUrl(body.baseUrl)
      setInterval(body.flushIntervalMillis > 0 ? body.flushIntervalMillis : UI_DEFAULT_FLUSH_INTERVAL_MILLIS)
      setPosition(body.position)
      setLive(body.reporting)
    }).catch((err: Error) => { if (!controller.signal.aborted) setRefreshError(err.message) })
    return () => controller.abort()
  }, [])

  const ready = loaded !== undefined
  const locked = loaded?.locked ?? false
  const disabled = busy || locked || !ready
  const hasAppKey = loaded?.hasAppKey ?? false
  const addressChanged = ready && baseUrl.trim() !== (loaded?.baseUrl ?? '')
  // ★ 保存按钮的判据（与宿主侧的校验一一对应）：
  //   要么给了 appKey（会真的去校验一次），要么「只改本机偏好」——必须已经配好凭证且地址没动。
  const canSave = !disabled && (appKey.trim() !== '' || (hasAppKey && !addressChanged))

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!canSave) return
    setBusy(true)
    setMessage('')
    try {
      const response = await fetch(UI_SETTINGS_PATH, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseUrl,
          appKey,
          flushIntervalMillis: interval,
          position,
        }),
      })
      if (!response.ok) throw new Error(`保存失败（HTTP ${response.status}）`)
      const result = await response.json() as Record<string, unknown>
      if (result['ok'] !== true) { setMessage(typeof result['reason'] === 'string' ? result['reason'] : '保存失败'); return }

      // 服务端认下的姓名（不是我们提交的那个）
      const name = typeof result['name'] === 'string' ? result['name'] : ''
      const nextPosition = result['position'] as UiPosition | undefined
      const reporting = result['reporting'] as UiReportingStatus | undefined
      setAppKey('')
      if (reporting) setLive(reporting)
      if (nextPosition) {
        setPosition(nextPosition)
        // ★ 就地换位置：不必刷新页面
        applyPosition(nextPosition)
      }
      setLoaded((prev) => prev === undefined ? prev : {
        ...prev,
        baseUrl: addressChanged ? baseUrl : prev.baseUrl,
        hasAppKey: true,
        position: nextPosition ?? prev.position,
        flushIntervalMillis: typeof result['flushIntervalMillis'] === 'number' ? result['flushIntervalMillis'] : interval,
        signed: true,
        name: name || prev.name,
        restartRequired: result['restartRequired'] === true,
      })
      setMessage(describeSaved(name, reporting, result['restartRequired'] === true))
    } catch {
      setMessage('无法保存配置，请检查宿主连接后重试。')
    } finally {
      setBusy(false)
    }
  }

  const field = (
    label: string,
    value: string,
    change: (value: string) => void,
    type = 'text',
    placeholder = '',
  ): ReactNode => h('label', { className: 'atr-field' }, label,
    h('input', {
      type, value, placeholder, disabled, autoComplete: 'off',
      onChange: (event: { target: { value: string } }) => change(event.target.value),
    }))

  const head = h('div', { className: 'atr-head' },
    h('strong', null, '上报设置'),
    h('span', { className: 'atr-grow' }),
    h('button', { type: 'button', className: 'atr-btn', onClick: props.onClose, disabled: busy }, '返回我的用量'))

  const tabs = h('div', { className: 'atr-segmented atr-tabs', role: 'tablist' },
    h('button', {
      type: 'button', role: 'tab', className: 'atr-btn', 'aria-pressed': tab === 'connection',
      onClick: () => setTab('connection'),
    }, '连接配置'),
    h('button', {
      type: 'button', role: 'tab', className: 'atr-btn', 'aria-pressed': tab === 'debug',
      onClick: () => setTab('debug'),
    }, '上报调试'))

  if (tab === 'debug') {
    return h('section', { className: 'atr-settings' }, head, tabs,
      h(ReportDebugPanel, { onConfigure: () => setTab('connection') }))
  }

  if (!ready) {
    return h('section', { className: 'atr-settings' }, head,
      h('p', { role: 'status' }, refreshError ? `读取配置失败（${refreshError}）。` : '正在读取配置…'))
  }

  return h('section', { className: 'atr-settings' }, head, tabs,
    h('p', { role: 'status' }, message || describeCurrent(loaded, live)),
    locked ? h('p', null, '此配置由部署文件或环境变量管理，请联系管理员修改。') : null,
    h('form', { onSubmit: submit, className: 'atr-form' },
      field('服务端地址', baseUrl, setBaseUrl, 'url', '例如 http://127.0.0.1:8787'),
      field('appKey（管理员发放）', appKey, setAppKey, 'password',
        hasAppKey ? '已配置；只改下面的选项时留空即可' : '粘贴平台「appKey 管理」页面复制的凭证'),
      h('label', { className: 'atr-field' }, '上报间隔',
        h('select', {
          value: String(interval), disabled,
          onChange: (event: { target: { value: string } }) => setInterval(Number(event.target.value)),
        },
          // 当前值不在预设档位里（部署配置写了个别的数）时也要显示出来，否则
          // select 会自动跳到第一项 —— 用户以为保存的就是那个值。
          UI_FLUSH_INTERVALS.some((item) => item.millis === interval)
            ? null
            : h('option', { value: String(interval) }, `${intervalLabel(interval)}（部署配置）`),
          ...UI_FLUSH_INTERVALS.map((item) =>
            h('option', { key: item.millis, value: String(item.millis) }, item.label)),
        )),
      h('label', { className: 'atr-field' }, '面板位置',
        h('select', {
          value: position, disabled,
          onChange: (event: { target: { value: string } }) => setPosition(event.target.value as UiPosition),
        },
          ...(Object.keys(POSITION_LABELS) as UiPosition[]).map((id) =>
            h('option', { key: id, value: id }, POSITION_LABELS[id])))),
      h('p', { className: 'atr-note' },
        'appKey 保存在本机、不回显；姓名与分组以服务端校验结果为准。保存后立即生效，无需重启 DSH：' +
        '启用后自动补报本机全部历史用量，失败会重试。只上报用量统计，不采集对话内容。'),
      h('button', { className: 'atr-btn atr-primary', type: 'submit', disabled: !canSave },
        busy ? '处理中…' : '验证并保存'),
      h('p', { className: 'atr-note' },
        hasAppKey && !addressChanged && appKey.trim() === ''
          ? '留空 appKey 时只更新间隔与位置，不会重新校验凭证。'
          : '保存会向服务端校验 appKey 并取回署名。')),
  )
}

/**
 * 保存成功后的提示 —— 必须如实说清「现在到底在不在上报」。
 *
 * ★ 导出是为了让它可被单测钉住：这句话是用户判断「保存到底成没成」的唯一依据，
 *   说成「已保存」而实际没在上报，等于把排查引到完全相反的方向。
 */
export function describeSaved(name: string, reporting: UiReportingStatus | undefined, restartRequired: boolean): string {
  if (restartRequired) {
    return `已保存${name ? `署名 ${name}` : ''}，但宿主未能就地生效：请重启 DSH 后启用新的上报连接。`
  }
  if (reporting?.enabled) {
    return `已保存并开始上报${name ? `（署名 ${name}）` : ''} → ${reporting.endpoint}。现在起会自动补报历史用量。`
  }
  return `已保存${name ? `署名 ${name}` : ''}，但上报仍未启用：${reporting?.reason ?? '原因未知'}。`
}

/** 打开面板时的状态说明（尚未保存过任何东西）。 */
export function describeCurrent(loaded: UiSettingsPayload, live: UiReportingStatus | undefined): string {
  const reporting = live ?? loaded.reporting
  const who = loaded.signed
    ? `当前署名：${loaded.name}${loaded.group ? ` · ${loaded.group}` : ''}`
    : '尚未配置 appKey：只查看本机统计，不采集也不上报'
  const state = reporting.enabled
    ? `上报中 → ${reporting.endpoint}，每 ${intervalLabel(loaded.flushIntervalMillis || UI_DEFAULT_FLUSH_INTERVAL_MILLIS)}一批`
    : `未上报（${reporting.reason ?? '未启用'}）`
  return `${who}。${state}。`
}