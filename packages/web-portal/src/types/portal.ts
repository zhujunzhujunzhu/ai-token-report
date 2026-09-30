/**
 * 部门看板的展示层类型与选项常量。
 *
 * ★ 所有数据字段的类型**直接来自 `@ai-token-report/shared`**，
 *   这里只补充「页面自己的排版概念」（选项列表、格式化后的视图模型）。
 *   早期本地页曾用 mock 时代的字段（`apiKey` / `cost` / `requests`），
 *   与后端完全对不上，接上真数据后就是一片空图表 —— 不再重演。
 */

import {
  UNATTRIBUTED_USER,
  type BreakdownRow,
  type GroupBy,
  type RecordRow,
  type StatsGroupOption,
  type StatsMemberOption,
} from '@ai-token-report/shared'

/** 时间窗选项（value 是服务端认识的具名周期）。 */
export interface TimeRangeOption {
  value: string
  label: string
}

/** 通用下拉 / 页签选项。 */
export interface SelectOption {
  value: string
  label: string
}

/**
 * 「自定义区间」的哨兵值。
 *
 * ⚠️ 它**不是**服务端认识的周期：选中它时前端发的是 `from` / `to`
 *   （epoch 毫秒），而不是 `period`。两者绝不能同时发 ——
 *   服务端的语义是「显式 from/to 覆盖 period」，同时发会让
 *   `period=custom` 先被当成未知周期而 400。
 *
 * ⚠️ 必须定义在 `TIME_RANGES` **之前**：常量在模块求值时初始化，
 *   写在使用点之后会踩 TDZ（`Cannot access before initialization`），
 *   而这个错误只在页面加载时出现，看起来像「整个页面白屏」。
 */
export const CUSTOM_PERIOD = 'custom'

/**
 * 顶部时间窗选项。
 *
 * ★ 每一项（除「自定义区间」）都是**服务端认识的具名周期**，页面只把它原样传出去，
 *   由 `core/range.ts` 解析成绝对时间 —— 前端不做任何日期换算。
 *
 * ⚠️ 「自定义区间」是**唯一**的例外：它对应的是用户在输入框里明确选定的
 *   两个绝对时刻（`from` / `to`），那不是口径，而是输入本身。
 */
export const TIME_RANGES: TimeRangeOption[] = [
  { value: 'today', label: '今天' },
  { value: 'yesterday', label: '昨天' },
  { value: 'week', label: '本周' },
  { value: 'lastweek', label: '上周' },
  { value: 'last7d', label: '最近 7 天' },
  { value: 'last14d', label: '最近 14 天' },
  { value: 'month', label: '本月' },
  { value: 'lastmonth', label: '上月' },
  { value: 'last30d', label: '最近 30 天' },
  { value: 'last90d', label: '最近 90 天' },
  { value: 'year', label: '今年' },
  { value: CUSTOM_PERIOD, label: '自定义区间…' },
]

/**
 * 分布页签（人员排行单独一栏，见 `RankingTable`）。
 *
 * ⚠️ 这里**没有** `group` / `user`：多对多下的分组维度是「展开」语义
 *   （一条事件计入所属的每个分组），和这些等值维度的表放同一组页签里，
 *   会让人以为它们可以相加。分组排行在总览里单独成块并附口径说明，
 *   `GroupBy` 里的 `'group'`（协议已定义）由那里使用。
 */
export const BREAKDOWN_TABS: { value: GroupBy; label: string }[] = [
  { value: 'provider-model', label: '厂商 / 模型' },
  { value: 'model', label: '模型' },
  { value: 'provider', label: '厂商' },
  { value: 'project', label: '项目' },
]

/** 明细表的列定义。 */
export interface DetailColumn {
  key: string
  title: string
  /** 是否右对齐（数值列）。 */
  numeric: boolean
}

export const RECORD_COLUMNS: DetailColumn[] = [
  { key: 'ts', title: '时间', numeric: false },
  { key: 'userId', title: '署名', numeric: false },
  { key: 'provider', title: '厂商', numeric: false },
  { key: 'model', title: '模型', numeric: false },
  { key: 'calls', title: '调用', numeric: true },
  { key: 'inputTokens', title: '未缓存输入', numeric: true },
  { key: 'outputTokens', title: '输出', numeric: true },
  { key: 'cacheReadTokens', title: '缓存读', numeric: true },
  { key: 'totalTokens', title: '计费总量', numeric: true },
]

/**
 * 趋势用哪个分桶：当天/昨天看小时，更长窗口看天。
 *
 * ★ 这里只决定「向服务端要哪种粒度」，**不涉及任何时间换算** ——
 *   窗口边界仍然由服务端解析（具名周期）或由用户显式给定（自定义区间）。
 *
 * @param spanMs 自定义区间的跨度。跨过 2 天的窗口按小时画会得到一屏挤在一起的
 *   柱子（`last90d` 按小时 = 2160 个点），因此按跨度选粒度。
 */
export function bucketFor(period: string, spanMs?: number): 'day' | 'hour' {
  if (period === CUSTOM_PERIOD) {
    // 自定义区间没有「今天/昨天」这种语义，只能看跨度
    return spanMs !== undefined && spanMs <= 2 * 86_400_000 ? 'hour' : 'day'
  }
  return period === 'today' || period === 'yesterday' ? 'hour' : 'day'
}

/**
 * 时间范围下拉变更后是否可以立即查询。
 *
 * ★ 三个多选 / 单选下拉（时间范围 / 分组 / 人员 / 厂商）是离散选择，
 *   **选中即筛**，不必再点「查询」；模型是子串输入，逐字符查询没有意义，
 *   仍由按钮或回车提交。
 *
 * ⚠️ 自定义区间例外：切过去的那一瞬间两个输入框必然是空的，
 *   此时查询只会换来一句「请选择开始与结束时间」（`buildFilter` 的错误，
 *   且发出去还会因 `period=custom` 不是服务端认识的周期而 400）。
 *   必须等起止时间都填齐再自动生效。
 */
export function periodReadyForQuery(
  period: string,
  from: string,
  to: string,
): boolean {
  return period !== CUSTOM_PERIOD || (!!from && !!to)
}

/**
 * 供应商下拉里的一项。
 *
 * ★ 与人员候选（`MemberFilterOption`）是同一个形状思路：页面只关心
 *   「值、显示名、是不是使用者自己建的」。
 */
export interface ProviderFilterOption {
  /** 筛选时原样发给服务端的名字。 */
  value: string
  label: string
  /**
   * `true` = 使用者手动创建的（`allow-create`），只存在本机浏览器里。
   *
   * ⚠️ 它与「库里有这个供应商」是两件事：自定义项**不写库**，也**不保证有用量**。
   *   它的用途只有一个：把名字记下来，下次不用再手输。
   */
  custom: boolean
}

/**
 * 供应商下拉的候选集合：**库里的目录 ∪ 使用者自建的**。
 *
 * ★ 目录（`GET /api/v1/stats/providers`）给的是**归一化后**的展示名，与筛选的
 *   匹配口径同一份 —— 页面不在这里做任何名字变换。
 * ★ 自建项排在目录之后，并在 `custom` 上标出来：同名的以目录为准
 *   （库里真的有这个名字，它就不是「自定义」）。
 *
 * ⚠️ 服务端对每个值仍是**子串**匹配，所以「输入一半的名字」也能筛 ——
 *   这是既有语义（CLI `--provider` 同款），不是这里引入的。下拉的可搜索
 *   （`filterable`）只是把这件事变得看得见：搜到的每一项都能直接选。
 */
export function providerFilterOptions(
  catalog: readonly string[],
  custom: readonly string[],
): ProviderFilterOption[] {
  const options: ProviderFilterOption[] = []
  const seen = new Set<string>()
  for (const name of catalog) {
    const value = name.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    options.push({ value, label: value, custom: false })
  }
  for (const name of custom) {
    const value = name.trim()
    // ★ 与目录重名的不再列为自定义：那会让人以为有两个不同的选项，
    //   而筛选发出去的是同一个字符串。
    if (!value || seen.has(value)) continue
    seen.add(value)
    options.push({ value, label: value, custom: true })
  }
  return options
}

/**
 * 从当前选择里挑出**刚刚手输出来的**名字（去掉目录里已有的与已经记过的）。
 *
 * ★ 判据是「既不在目录、也不在已有自定义里」：下拉里能选到的值都来自这两处，
 *   所以剩下的只可能是使用者刚敲进去并回车的那一个 —— 把它记下来，
 *   下次打开下拉就能直接选，而不用再输一遍。
 * ⚠️ 副产物是「输入一半的子串」也会被记下来（服务端本来就是子串匹配）。
 *   这是刻意的：那是使用者自己建的一个筛选项，页面没有资格替他判断它「不完整」。
 *   不想要了用「清除自定义」——页面必须给出这个出口。
 */
export function newCustomProviders(
  selected: readonly string[],
  catalog: readonly string[],
  custom: readonly string[],
): string[] {
  const known = new Set<string>([...catalog, ...custom].map((name) => name.trim()))
  const added: string[] = []
  for (const name of selected) {
    const value = name.trim()
    if (!value || known.has(value)) continue
    known.add(value)
    added.push(value)
  }
  return added
}

/**
 * 归属键的展示文案。
 *
 * `unknown` 是协议里的未归属键（`UNATTRIBUTED_USER`），直接显示成
 * 「unknown」没人看得懂，显示成「未署名」才指出了动作（去本地页填一下）。
 */
export function userLabel(key: string): string {
  return key === UNATTRIBUTED_USER ? '未署名' : key
}

/** 同名人员用分组与短 ID 辅助区分；旧响应仍可显示旧人名。 */
export function identityLabel(row: BreakdownRow): string {
  return memberFilterLabel(
    row.label ?? userLabel(row.key),
    row.member_id,
    row.group_names ?? [],
  )
}

/**
 * 人员下拉里的一项。
 *
 * ★ 把两种来源归一成同一种形状：**人员目录**（`/api/v1/stats/members`）与
 *   **用量派生的归属键**（未署名 / 待确认历史）。下拉只需要「键、显示名、当前分组」，
 *   不必知道它来自哪一边。
 */
export interface MemberFilterOption {
  /** 服务端认识的不透明归属键：人员 UUID / `legacy:…` / `unknown`。 */
  key: string
  /** 已经拼好的展示名（同名消歧也在里面）。 */
  label: string
  /** 该人员的**当前**所属分组 ID；未分组与用量派生键都是空数组。 */
  groupIds: string[]
}

/**
 * 人员的显示文案：`姓名 · 分组、分组 · 短ID`。
 *
 * ★ 与 `identityLabel()` 共用同一份拼法：排行、明细与下拉里的同一个人
 *   必须长得一模一样，否则使用者会以为是两个人。
 * ⚠️ 两个人同名时，短 ID 是唯一能区分它们的可见线索 —— 别去掉它。
 */
export function memberFilterLabel(
  name: string,
  memberId: string | null | undefined,
  groupNames: readonly string[],
): string {
  const groups = groupNamesLabel(groupNames)
  return memberId
    ? `${name} · ${groups ? groups + ' · ' : ''}${memberId.slice(0, 8)}`
    : name
}

/**
 * 人员下拉的候选集合：**人员目录 ∪ 用量派生键**，并按所选分组收窄。
 *
 * ## 为什么候选不能只从用量里取
 *
 * 用量的分组聚合只回答「谁在这个窗口里用过量」。刚入职、休假、只在别的窗口
 * 用过的人一概不出现；一旦选中某个分组，下拉会**整个空掉** ——
 * 看起来像数据丢了，而不像「这段时间没人用」。所以名册以目录为准。
 *
 * ## 联动规则（分组在前、人员在后）
 *
 * - 未选分组 → **全部人员**（含窗口内零用量的人）
 * - 选中分组 → 只列**当前属于所选分组**的人（多对多：属于任一所选分组即列出）
 *
 * ⚠️ 「未署名 / 待确认历史」是**真实存在的归属状态**（见
 *   `docs/数据库重设计-接口与验收.md`），目录里表达不出来，必须保留；
 *   但它们不属于任何分组，所以选了分组时不再列出 —— 与分组 AND 之后必然是 0，
 *   留在下拉里只会让人选出一个「什么都没筛出来」的条件。
 * ⚠️ 目录**取不到**时（旧服务端没有这个接口 / 请求失败）不做任何收窄，
 *   回落到「只列用量里出现过的人」——不能凭一份空目录删掉使用者的选项。
 *
 * @param selectedGroups 当前筛选的分组 ID；空数组 = 不按分组收窄
 * @param groups         分组候选目录，仅用于把分组 ID 翻成展示名
 */
export function memberFilterOptions(
  directory: readonly StatsMemberOption[],
  usageRows: readonly BreakdownRow[],
  selectedGroups: readonly string[],
  groups: readonly StatsGroupOption[],
): MemberFilterOption[] {
  const nameOf = (groupId: string): string =>
    groups.find((group) => group.group_id === groupId)?.name ?? '未知分组'
  const listed = (member: StatsMemberOption): boolean =>
    selectedGroups.length === 0 ||
    member.group_ids.some((id) => selectedGroups.includes(id))
  // ★ 「目录能不能用来收窄」取决于目录里有没有人，而不是请求成功与否：
  //   凭证表形态的部署（还没有人员库）返回的就是一份空名册。
  const canNarrow = directory.length > 0

  const options: MemberFilterOption[] = []
  // ★ 去重按**整份名册**判定，而不是「已经列出来的那些」：一个人不在所选
  //   分组里时会从上面那段被跳过，若只记「已列出的人」，紧接着用量那段
  //   又会用他的用量行把他加回来 —— 分组筛选当场失效。
  const known = new Set(directory.map((member) => member.member_id))
  for (const member of directory) {
    if (!listed(member)) continue
    options.push({
      key: member.member_id,
      label: memberFilterLabel(
        // 与人员管理页同一种说法（那里也把归档与停用分开），
        // 否则同一个人在两页上显示成两种状态。
        member.status === 'active'
          ? member.name
          : `${member.name}（${member.status === 'archived' ? '已归档' : '停用'}）`,
        member.member_id,
        member.group_ids.map(nameOf),
      ),
      groupIds: [...member.group_ids],
    })
  }

  for (const row of usageRows) {
    // 目录里已经列过的人不再重复；剩下的分两类：
    //   · 有用量但**目录里翻不到**（目录拿不到 / 人员行已不在册）→ 照原样列出。
    //     让有用量的人从下拉里消失，看起来就是数据丢了。
    //   · 未署名 / 待确认历史 → 不属于任何分组，只有不筛分组时才列出。
    if (row.member_id && known.has(row.member_id)) continue
    if (!row.member_id && canNarrow && selectedGroups.length > 0) continue
    options.push({
      key: row.key,
      label: identityLabel(row),
      groupIds: [],
    })
  }
  return options
}

/**
 * 分组名列表的展示文案（多对多用「、」拼接）。
 *
 * ⚠️ 空数组是**有意义的状态**（这个人未分组），不是「没加载出来」：
 *   所以调用方要用 `|| '未分组'` 兜底，而不是把它当成缺失数据。
 */
export function groupNamesLabel(names: string[] | readonly string[] | undefined): string {
  return (names ?? []).join('、')
}

/**
 * 分组排行一行的显示名。
 *
 * ★ `by=group` 的行里 `key` 是**稳定 `group_id`**（归属的权威标识），
 *   而候选目录来自 `GET /api/v1/stats/groups` —— 用候选把 ID 翻成名字，
 *   页面不自己拼字符串、也不改任何数字。翻不到时保留原始 ID，
 *   宁可让人看见一个 UUID，也不要把行显示成空白。
 */
export function groupLabelOf(row: BreakdownRow, groups: readonly StatsGroupOption[]): string {
  if (row.label) return row.label
  return groups.find((group) => group.group_id === row.key)?.name ?? row.key
}

/**
 * 明细行里「该人员当前所属分组」的展示文案。
 *
 * ⚠️ 与 `row.group_name_snapshot`（上报当时的文本快照）是两件事：
 *   这里展示的是**当前**归属（`group_ids` 经候选目录翻译），
 *   快照只说明上报那一刻客户端自己填了什么。
 */
export function recordGroupNames(row: RecordRow, groups: readonly StatsGroupOption[]): string {
  const names = (row.group_ids ?? []).map(
    (id) => groups.find((group) => group.group_id === id)?.name ?? '未知分组',
  )
  return names.join('、') || '未分组'
}

/** 未归属行的展示标记（用于给那一行加醒目的底色）。 */
export function isUnattributed(key: string): boolean {
  return key === UNATTRIBUTED_USER
}
