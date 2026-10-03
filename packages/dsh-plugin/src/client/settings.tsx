/**
 * 插件设置页 —— **五件事：服务端地址、appKey、上报间隔、面板位置、会话日志根**，
 * 外加一个「上报调试」页签（看刚刚发出去了什么，见 `report-debug.tsx`）。
 *
 * ## 为什么是这几个字段（外加一个调试页）
 *
 * 员工手上真正拿到的东西只有两样：部门平台的地址，和管理员发的一串 appKey。
 * 其余全部是派生的：
 *
 * | 面板字段 | 从哪来 |
 * |---|---|
 * | 姓名 / 分组 | ★ **服务端校验结果**，不是用户填的 |
 * | 上报地址 `/api/v1/token-usage` | `baseUrl` + 固定路径 |
 * | 校验地址 `/api/v1/identity/verify` | 同上 |
 * | 上报间隔 / 面板位置 / 会话日志根 | 纯本机偏好（与凭证无关） |
 *
 * 旧版面板让用户分别填「姓名 / 身份 Key / 完整上报地址 / appKey」——
 * 四栏里有两栏是同一个意思（身份 Key 与 appKey 都只是凭证），
 * 还有一栏要求用户自己拼出完整接口路径。实测用户会把 API base URL 填进
 * 「姓名」，而真正该填的 appKey 栏空着。
 *
 * ## 会话日志根为什么值得占一栏
 *
 * 面板上的数字来自**本机会话日志**，缺省自动发现本机全部 DSH home，但有两种
 * 情况自动发现帮不上忙：① 某个客户端的目录名字不像 DSH（发现规则只提示、
 * 绝不自动采用），需要手填；② 想**只看其中几处**。
 *
 * ★ 因此这一栏必须把「我填的」与「现在真的在读的」**分开显示**：
 *   输入框回填的是保存过的那一份，下面那行是宿主**此刻实际生效**的根
 *   （含 `exists: false` 的逐项提示）。合成一个显示，用户就分不清
 *   「保存成功了」与「保存的东西真的起作用了」。
 *
 * ⚠️ 面板刻意**没有**「数据目录」（`dataDir`）：那个字段会连身份文件、本地库、
 *   outbox 与补报水位一起换掉，在面板里改等于「填完就变成另一个人」。
 *
 * ## ★ 保存后立刻生效
 *
 * 保存成功后宿主会**就地**换连接（不必重启 DSH），并把 `reporting`
 * （上报中 / 未上报及原因）回给页面。所以这里如实显示：
 * 「已保存并开始上报 → 地址」。位置由 `position.ts` 的总线就地切换，
 * 会话日志根由宿主的统计上下文就地改用新根（下一次取数即生效）。
 *
 * ## 凭证只提交、不回显
 *
 * GET 只回「填没填」（`hasAppKey`），appKey 绝不发回浏览器；
 * 保存成功后立刻清空输入框。浏览器存储（localStorage / cookie）里也不留一份。
 *
 * ## 「只改偏好」不必重新校验 appKey
 *
 * 已经配好的人改间隔/位置/日志根时不该被要求再粘一次密钥（那串东西往往
 * 已经不在手边）。**连一次都没配过凭证的人也能只保存偏好** ——
 * 那三项都是纯本机读/上报偏好，与「能不能上报」无关。
 */
import { createElement as h, useEffect, useState, type ReactNode, type FormEvent } from 'react'
import {
  UI_DEFAULT_FLUSH_INTERVAL_MILLIS,
  UI_FLUSH_INTERVALS,
  UI_SETTINGS_PATH,
  readUiRootsView,
  readUiExtraSources,
  readUiSettings,
  type UiPosition,
  type UiReportingStatus,
  type UiRootsSource,
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

/** 生效日志根的来源说法。 */
const ROOTS_SOURCE_LABELS: Record<UiRootsSource, string> = {
  panel: '面板里设置的',
  config: '部署配置下发的',
  env: '环境变量指定的',
  auto: '自动发现',
}

/** 间隔的可读说法（后端值 → 文案）。 */
export function intervalLabel(millis: number): string {
  if (millis % 60_000 === 0) return `${millis / 60_000} 分钟`
  return `${millis / 1_000} 秒`
}

/**
 * 把输入框里的多行文本收成路径数组（每行一个）。
 *
 * 空行丢掉（多一个换行是常事）；**不做** `~` 展开与绝对化 ——
 * 那是 core `resolvePaths()` 唯一的职责（`join()` 不展开 `~`，
 * 在这里展开会让「配置 → 路径」出现第二处实现）。
 */
export function parseDshHomesText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * 「现在真的在读哪几处」那一行。
 *
 * 返回空串 = 宿主没给这个信息（旧宿主），调用方据此**整行不显示** ——
 * 绝不能改成「0 个根」：那会让一个正常的部署看起来像统计范围空了。
 */
export function rootsSummary(roots: { path: string; exists: boolean }[], source: UiRootsSource): string {
  if (roots.length === 0) return ''
  const missing = roots.filter((root) => !root.exists).length
  const head = `当前生效 ${roots.length} 个会话日志根（${ROOTS_SOURCE_LABELS[source]}）`
  return missing === 0
    ? `${head}，都在。`
    : `${head}；其中 ${missing} 个根下没有 sessions 目录，那些位置现在读不到日志。`
}

type Tab = 'connection' | 'debug'

/**
 * 把「其它来源」输入框里的文本收成 id 数组（逗号 / 空格 / 换行都能分隔）。
 *
 * 只做「切分 + 去空白 + 小写 + 去重」：**认不认识**由宿主判定
 * （它拿得到已注册来源表，而且拼错必须在保存时当场报错 —— 见
 * `settings.ts` 的 `parseExtraSources`）。在这里也做一遍校验就等于第二处口径。
 */
export function parseExtraSourcesText(text: string): string[] {
  const out: string[] = []
  for (const part of text.split(/[\s,，、]+/)) {
    const id = part.trim().toLowerCase()
    if (id !== '' && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * 「其它来源」那一行：把「现在真的并进了哪些来源」说清楚。
 *
 * 返回空串 = **只统计 DSH**（默认）—— 调用方据此说明默认范围，
 * 而不是显示一个空的列表（「空」与「没配」在界面上必须是一回事，都是 DSH）。
 */
export function extraSourcesSummary(effective: readonly string[]): string {
  if (effective.length === 0) return '当前只统计 DSH（本机其它 AI 客户端的用量不计入面板）。'
  return `当前统计 DSH + ${effective.map((id) => SOURCE_LABELS[id] ?? id).join(' + ')}。`
}

/** 来源 id → 展示名（不认识的值原样显示，新来源不改前端也能看出来）。 */
const SOURCE_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  trae: 'Trae',
  'trae-cn': 'Trae CN',
  workbuddy: 'WorkBuddy',
}

export function SettingsPanel(props: { onClose(): void }): ReactNode {
  const [loaded, setLoaded] = useState<UiSettingsPayload | undefined>(undefined)
  const [refreshError, setRefreshError] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [appKey, setAppKey] = useState('')
  const [interval, setInterval] = useState(UI_DEFAULT_FLUSH_INTERVAL_MILLIS)
  const [position, setPosition] = useState<UiPosition>('dock')
  /**
   * 会话日志根的输入框（每行一个）。
   *
   * ⚠️ 与 `loaded.dshHomes` 分开存：输入框里的东西在被保存之前只是草稿，
   *   而下方「当前生效」那一行必须始终反映**宿主此刻的事实**。
   */
  const [dshHomesText, setDshHomesText] = useState('')
  /**
   * 「其它来源」的输入框（逗号 / 空格 / 换行分隔）。
   *
   * ⚠️ 与 `dshHomesText` 同一个道理：输入框里的是**草稿**，下方那行「当前生效」
   *   必须始终反映宿主此刻的事实。空 = 只统计 DSH（默认）。
   */
  const [extraSourcesText, setExtraSourcesText] = useState('')
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
      setDshHomesText(body.dshHomes.join('\n'))
      setExtraSourcesText(body.extraSources.join(', '))
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
  //   给了 appKey → 会真的去校验一次；否则是「只改本机偏好」——地址必须没动。
  //   ⚠️ 刻意**不**要求「已经配过凭证」：间隔 / 位置 / 会话日志根都是本机偏好，
  //      一个还没署名、只想看本机用量的人也要能保存它们（宿主不再拦这条路）。
  const canSave = !disabled && (appKey.trim() !== '' || !addressChanged)

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
          dshHomes: parseDshHomesText(dshHomesText),
          extraSources: parseExtraSourcesText(extraSourcesText),
        }),
      })
      if (!response.ok) throw new Error(`保存失败（HTTP ${response.status}）`)
      const result = await response.json() as Record<string, unknown>
      if (result['ok'] !== true) { setMessage(typeof result['reason'] === 'string' ? result['reason'] : '保存失败'); return }

      // 服务端认下的姓名（不是我们提交的那个）
      const name = typeof result['name'] === 'string' ? result['name'] : ''
      const nextPosition = result['position'] as UiPosition | undefined
      const reporting = result['reporting'] as UiReportingStatus | undefined
      // ★ 宿主的落盘结果才是权威：它会裁掉空行与重复项（我们照它回填输入框）。
      const roots = readUiRootsView(result)
      setAppKey('')
      setDshHomesText(roots.dshHomes.join('\n'))
      // 宿主的落盘结果同样是权威：它会把 `dsh` / 重复项剔掉（照它回填，不照我们提交的）
      setExtraSourcesText(readUiExtraSources(result).join(', '))
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
        ...roots,
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

  const roots = loaded.effectiveRoots
  const rootsLine = rootsSummary(roots, loaded.rootsSource)
  const rootsPlaceholder = roots.length > 0
    ? roots.map((root) => root.path).join('\n')
    : '例如 ~/.dsh；留空 = 自动发现本机全部 DSH home'

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
      // ★ 会话日志根：多套 DSH 并存 / 某个客户端的目录名不像 DSH 时，手填能救回来。
      //   空 = 不覆盖（跟随部署配置 / 自动发现），见 parseDshHomesText 的注释。
      h('label', { className: 'atr-field' }, '会话日志根（DSH home，每行一个）',
        h('textarea', {
          className: 'atr-textarea', rows: 3, spellCheck: false, disabled,
          value: dshHomesText, placeholder: rootsPlaceholder,
          onChange: (event: { target: { value: string } }) => setDshHomesText(event.target.value),
        }),
        h('span', { className: 'atr-note' },
          '留空 = 不覆盖，跟随部署配置或自动发现本机全部 DSH home。' +
          '填了就只看这几处（本机面板数字与历史补报都按它读日志）。')),
      // ★ 其它来源（多客户端）：DSH 之外的客户端各有自己的日志目录，面板只统计
      //   **显式列出来**的那些 —— 默认关，因为并进来意味着面板每次取数都会去
      //   增量扫那些日志（Codex 在本机是 1,495 个文件 / 2.8 GB）。
      h('label', { className: 'atr-field' }, '其它来源（本机其它 AI 客户端，逗号分隔）',
        h('input', {
          className: 'atr-input', type: 'text', spellCheck: false, disabled,
          value: extraSourcesText,
          placeholder: loaded.availableSources.length > 0
            ? `留空 = 只统计 DSH；可填 ${loaded.availableSources.join(' / ')} 或 all`
            : '留空 = 只统计 DSH',
          onChange: (event: { target: { value: string } }) => setExtraSourcesText(event.target.value),
        }),
        h('span', { className: 'atr-note' },
          '留空 = 只统计 DSH（默认）。写 trae 这类来源 id 会把那个客户端的用量一并算进面板；' +
          'all = 全部已注册来源（冷扫时可能要等一会儿）。')),
      h('p', { className: 'atr-note' }, extraSourcesSummary(loaded.extraSourcesEffective)),
      // ★「现在真的在读哪几处」必须单独一行显示：只给输入框，用户分不清
      //   「我存的」与「真的生效的」——而这两件事在本插件里最容易不一致。
      rootsLine === ''
        ? null
        : h('div', { className: 'atr-roots' },
            h('p', { className: 'atr-note' }, rootsLine),
            ...roots.map((root) =>
              h('p', { key: root.path, className: 'atr-note atr-root' },
                root.exists ? root.path : `${root.path}（没有 sessions 目录）`))),
      h('p', { className: 'atr-note' },
        'appKey 保存在本机、不回显；姓名与分组以服务端校验结果为准。保存后立即生效，无需重启 DSH：' +
        '启用后自动补报本机全部历史用量，失败会重试。只上报用量统计，不采集对话内容。'),
      h('button', { className: 'atr-btn atr-primary', type: 'submit', disabled: !canSave },
        busy ? '处理中…' : '验证并保存'),
      // ★ 这句必须与**这一次会不会去校验**对上：没配过凭证的人只改偏好时，
      //   说「会向服务端校验 appKey」是一句做不到的承诺（而且他会以为必须填那串东西）。
      h('p', { className: 'atr-note' },
        appKey.trim() === '' && !addressChanged
          ? hasAppKey
            ? '留空 appKey 时只更新间隔、位置与会话日志根，不会重新校验凭证。'
            : '还没有凭证：保存只记下间隔、位置与会话日志根（仍不上报）。要开始上报，请填上 appKey。'
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