/**
 * 插件设置页 —— **六件事：服务端地址、appKey、上报间隔、面板位置、会话日志根、
 * 项目名称别名**（最后一项归在「自定义配置」区），外加一个「上报调试」页签
 * （看刚刚发出去了什么，见 `report-debug.tsx`）。
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
 * | 项目名称别名 | 纯本机**显示口径**（`<数据目录>/project-aliases.txt`） |
 *
 * ## 「自定义配置」区：项目名称别名
 *
 * 面板上的「项目」维度取的是会话的 `cwd` 最后一段（`core/src/aggregate.ts` 的
 * `projectName()`）—— 同一个仓库从根目录与子目录分别开会得到两个名字
 * （`my-project` 与 `core`），看起来像两个项目。
 *
 * ★ 这一栏把 `显示名 = 匹配值, 匹配值` 写成规则，**只改显示**：
 *   ① `cwd` 原值与上报数据一个字节都不动（部门看板的项目口径由服务端的
 *      「项目归一化」规则决定，与本栏无关，面板文案必须说清这一点）；
 *   ② 同一份文件被**四种离线形态**共用（插件面板 / `token_usage` 工具 /
 *      本地页 / CLI），所以四处的项目名不可能各说各话；
 *   ③ 「输入框里的草稿」与「此刻真的生效的规则」分开显示：只给输入框，
 *      用户分不清「保存成功了」与「保存的东西真的起作用了」（与会话日志根同一个道理）。
 */

import { createElement as h, useEffect, useState, type ReactNode, type FormEvent } from 'react'
import {
  UI_DEFAULT_FLUSH_INTERVAL_MILLIS,
  UI_FLUSH_INTERVALS,
  UI_SETTINGS_PATH,
  readUiProjectAliasesView,
  readUiRootsView,
  readUiSettings,
  type UiPosition,
  type UiProjectAliasesView,
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

/** 别名规则的两种匹配模式的可读说法（与宿主 `isProjectPathRule()` 的判定同源）。 */
const ALIAS_MODE_LABELS: Record<'path' | 'repo', string> = {
  path: '路径前缀',
  repo: '仓库名',
}

/** 「此刻生效的规则」最多逐条列出几条（再多就换成一行计数）。 */
const ALIAS_LINES_MAX = 12

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

/**
 * 「此刻真的生效的别名规则」那一行。
 *
 * ★ 三种状态必须能分开（与会话日志根的 `rootsSummary` 同一个道理）：
 * - `note` 非空（宿主说整份不生效）→ **原样转述原因**，绝不改写成「没有别名」：
 *   使用者会以为「我没配过」，而真实情况是「配了但一行写错了」；
 * - 一条规则都没有且没有 note → 没配过，如实说明「项目名 = cwd 最后一段」；
 * - 有规则 → 逐条列出（`显示名 ⇐ 匹配值`），让人一眼核对「我写的被认了没有」。
 */
export function aliasesSummary(view: UiProjectAliasesView): string {
  const note = view.projectAliasesNote
  if (note !== undefined && note !== '') return note
  const rules = view.effectiveProjectAliases
  if (rules.length === 0) return '还没有别名规则：项目名就是会话目录名的最后一段（例如 my-project）。'
  return `当前生效 ${rules.length} 条别名规则：`
}

type Tab = 'connection' | 'debug'

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
   * 「自定义配置 → 项目名称别名」的输入框（多行文本，逐字写盘）。
   *
   * ⚠️ 与 `loaded.projectAliases` 分开存，理由同 `dshHomesText`：输入框里的是
   *   草稿，下面那行「当前生效」必须始终反映**宿主此刻的事实**。
   *   🚨 也**不做** trim / 重排：磁盘上那份原文要能被逐字节回填，
   *      否则用户改一处、保存后会看到自己没写过的空白变化。
   */
  const [projectAliasesText, setProjectAliasesText] = useState('')
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
      setProjectAliasesText(body.projectAliases)
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
          // ★ 原文直接提交，**不**在这里切行 / 去空行 / trim：解析与校验是宿主
          //   （`parseProjectAliasText()`）的唯一职责，浏览器半再解析一遍就是
          //   第二个实现 —— 而且注释行会被它悄悄吃掉（保存后原文不再相同）。
          projectAliases: projectAliasesText,
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
      // ★ 别名的「权威」是磁盘上那份原文（宿主写完后回读的）。
      //   ⚠️ 只在宿主**真的带了这个字段**时才回填：老宿主不带它，
      //      照 `''` 回填会把用户刚写的那段草稿悄悄清掉（看起来像保存成功但内容没了）。
      const aliases = readUiProjectAliasesView(result)
      setAppKey('')
      setDshHomesText(roots.dshHomes.join('\n'))
      if (typeof result['projectAliases'] === 'string') setProjectAliasesText(aliases.projectAliases)
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
        ...aliases,
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
  // 「此刻真的生效的别名规则」——来自宿主，**不是**输入框里的草稿
  const aliasLine = aliasesSummary(loaded)
  const aliasRules = loaded.effectiveProjectAliases

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
      // ── ★「自定义配置」区 ────────────────────────────────────────────
      //
      // 与上面五项（连接 + 本机偏好）分开成一块：这里放的是**本机显示口径**，
      // 不涉及凭证、不改上报数据、也不影响部门看板 —— 标题必须让这条边界一眼可见，
      // 否则使用者会以为「配了别名，部门看板上的项目名也会变」。
      h('div', { className: 'atr-section' },
        h('span', { className: 'atr-section-title' }, '自定义配置'),
        h('span', { className: 'atr-section-note' },
          '这里的东西只改变本机看到的名字，不改上报数据，也不影响部门看板。'),
        h('label', { className: 'atr-field' }, '项目名称别名（每行一条：项目名 = 路径或仓库名）',
          h('textarea', {
            className: 'atr-textarea', rows: 4, spellCheck: false, disabled,
            value: projectAliasesText,
            placeholder: 'presales-kb-parent = D:\\Coding\\presales-kb-parent\nai-token-report = ai-token-report',
            onChange: (event: { target: { value: string } }) => setProjectAliasesText(event.target.value),
          }),
          h('span', { className: 'atr-note' },
            '等号左边是显示的项目名；右边写一个或多个「匹配值」，用逗号分开。' +
            '含路径分隔符 = 只在那个位置的路径前缀生效（按分隔符边界，不吃邻居项目）；' +
            '不含分隔符 = 该仓库名在任意位置都折进来。' +
            '留空 = 不折叠，项目名仍取会话目录名的最后一段；`#` 开头的行是注释。')),
        // ★「此刻真的生效的规则」必须单独显示：只给输入框，用户分不清
        //   「保存成功了」与「保存的东西真的起作用了」。
        h('div', { className: 'atr-roots' },
          h('p', { className: 'atr-note' }, `${aliasLine}（保存后才更新）`),
          ...aliasRules.slice(0, ALIAS_LINES_MAX).map((rule) =>
            h('p', { key: `${rule.alias}\u0001${rule.prefix}`, className: 'atr-note atr-root' },
              `${rule.alias} ⇐ ${rule.prefix}（${ALIAS_MODE_LABELS[rule.mode]}）`)),
          aliasRules.length > ALIAS_LINES_MAX
            ? h('p', { className: 'atr-note' }, `… 另有 ${aliasRules.length - ALIAS_LINES_MAX} 条`)
            : null)),
      h('button', { className: 'atr-btn atr-primary', type: 'submit', disabled: !canSave },
        busy ? '处理中…' : '验证并保存'),
      // ★ 这句必须与**这一次会不会去校验**对上：没配过凭证的人只改偏好时，
      //   说「会向服务端校验 appKey」是一句做不到的承诺（而且他会以为必须填那串东西）。
      h('p', { className: 'atr-note' },
        appKey.trim() === '' && !addressChanged
          ? hasAppKey
            ? '留空 appKey 时只更新间隔、位置、会话日志根与项目名称别名，不会重新校验凭证。'
            : '还没有凭证：保存只记下间隔、位置、会话日志根与项目名称别名（仍不上报）。要开始上报，请填上 appKey。'
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