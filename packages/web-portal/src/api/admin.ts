/** 数据库人员管理客户端。对象 ID 定位、版本防覆盖，秘密只随签发响应返回。 */
import type {
  PortalMember, PortalGroup, PortalReportToken, PortalStorageResponse,
  PortalAuditResponse, PortalCreateMemberRequest, PortalUpdateMemberRequest, PortalMemberRolesRequest,
  PortalMemberStatusRequest, PortalLoginAccountRequest, PortalLoginStatusRequest,
  PortalIssueTokenRequest, PortalTokenVersionRequest, PortalTokenScopesRequest, PortalTokenExpiryRequest,
  PortalIssueAppKeyRequest, PortalAppKeyListResponse,
  PortalMemberResult, PortalTokenResult, PortalGroupResult, PortalGroupVersionRequest,
  PortalMutationResult,
  PortalRoleListResponse, PortalCreateRoleRequest, PortalRoleUpdateRequest,
  PortalRoleStatusRequest, PortalRoleResult,
  PortalLegacyAttribution, PortalConfirmLegacyRequest, PortalLegacyResult,
  PortalProviderAliasListResponse, PortalProviderAliasResult,
  PortalSetProviderAliasRequest, PortalProviderAliasIdRequest, PortalProviderAliasStatusRequest,
  PortalProjectAliasListResponse, PortalProjectAliasResult,
  PortalSetProjectAliasRequest, PortalProjectAliasIdRequest, PortalProjectAliasStatusRequest,
  PortalModelPriceListResponse, PortalModelPriceResult,
  PortalSetModelPriceRequest, PortalModelPriceIdRequest,
} from '@ai-token-report/shared'
import { post, request } from './request.js'

const root = '/api/v1/admin'
const members = root + '/members'
export const fetchMembers = () => request<{ members: PortalMember[] }>(members)
/**
 * ★ 角色目录 + 权限目录一次读全。
 *
 * ⚠️ 权限勾选清单必须来自这里的 `permissions`（服务端 `permissions` 表），
 *   页面自己硬编码一份就会漏掉数据库里真实存在的权限，而它看起来「就这些」。
 */
export const fetchRoles = () => request<PortalRoleListResponse>(root + '/roles')
/**
 * 角色定义管理（新建 / 改名改权限 / 启停）。
 *
 * ★ 与 `updateRoles`（给人分配角色）是两件事：那个改的是 `member_roles`，
 *   这三个改的是 `roles` 与 `role_permissions`。命名上刻意区分开。
 */
export const createRole = (input: PortalCreateRoleRequest) => post<PortalRoleResult>(root + '/roles', input)
export const updateRole = (input: PortalRoleUpdateRequest) => post<PortalRoleResult>(root + '/roles/update', input)
export const updateRoleStatus = (input: PortalRoleStatusRequest) => post<PortalRoleResult>(root + '/roles/status', input)
/**
 * 分组目录。
 *
 * ⚠️ 这是**管理**目录（`groups:read` / `groups:manage`）：人员页与分组管理页
 *   用它渲染可选项。看板侧的筛选项与分组排行候选项走
 *   `GET /api/v1/stats/groups`（`stats:read`）—— 能看数据的人不一定有分组管理权限，
 *   多读一个管理接口就多一处 403。见 `portal.ts` 的 `fetchGroups`。
 */
export const fetchGroups = () => request<{ groups: PortalGroup[] }>('/api/v1/groups')
export const fetchStorage = () => request<PortalStorageResponse>(root + '/storage')
export const fetchAudit = () => request<PortalAuditResponse>(root + '/audit?limit=30')
export const fetchLegacyAttributions = () => request<{ mappings: PortalLegacyAttribution[] }>(root + '/legacy-attributions')
export const confirmLegacyAttribution = (input: PortalConfirmLegacyRequest) => post<PortalLegacyResult>(root + '/legacy-attributions/confirm', input)
/**
 * 某位成员的凭证列表。
 *
 * ⚠️ 人员页已不再调用它（凭证统一在 appKey 管理页呈现），但服务端端点仍在
 *   且被 `e2e-admin.ts` 覆盖 —— 保留这层映射，让「把凭证视图放回人员页」
 *   只需改页面，而不必重新推导请求形状。
 */
export const fetchTokens = (memberId: string) => request<{ tokens: PortalReportToken[] }>(
  members + '/tokens?' + new URLSearchParams({ member_id: memberId }),
)
/**
 * 列出全部 appKey。
 *
 * ★ 与 `fetchTokens(memberId)` 的分工：那个是「某个人有哪些凭证」，
 *   这个是 appKey 管理页的主体列表 —— 每行一把 key，并带出它发给了谁。
 * ⚠️ 需要 `tokens:manage`：响应体含凭证提示与权限范围，不是人员名单的附属信息。
 */
export const fetchAppKeys = () => request<PortalAppKeyListResponse>(root + '/appkeys')
export const issueMember = (input: PortalCreateMemberRequest) => post<PortalMemberResult>(members, input)
export const updateMember = (input: PortalUpdateMemberRequest) => post<PortalMemberResult>(members + '/update', input)
export const updateRoles = (input: PortalMemberRolesRequest) => post<PortalMemberResult>(members + '/roles', input)
export const updateMemberStatus = (input: PortalMemberStatusRequest) => post<PortalMemberResult>(members + '/status', input)
export const setLoginAccount = (input: PortalLoginAccountRequest) => post<PortalMemberResult>(members + '/login', input)
export const setLoginStatus = (input: PortalLoginStatusRequest) => post<PortalMemberResult>(members + '/login/status', input)
/**
 * 签发通用上报 Token（自选权限范围）。
 *
 * ⚠️ 页面入口已移除：appKey 页只用范围固定的 `issueAppKey`。函数保留的理由
 *   同 `fetchTokens` —— 服务端端点仍然存在，删掉它只剩「下次重写一遍」。
 */
export const issueToken = (input: PortalIssueTokenRequest) => post<PortalTokenResult>(members + '/tokens', input)
/**
 * 签发 appKey。
 *
 * ★ 走独立端点而不是 `issueToken`：appKey 的权限范围**由服务端固定**为
 *   「上报 + 获取统计」，请求体里给不出更宽的范围（见 `APP_KEY_SCOPES`）。
 */
export const issueAppKey = (input: PortalIssueAppKeyRequest) => post<PortalTokenResult>(members + '/appkey', input)
export const rotateToken = (input: PortalTokenVersionRequest) => post<PortalTokenResult>(members + '/tokens/rotate', input)
export const revokeToken = (input: PortalTokenVersionRequest) => post<PortalTokenResult>(members + '/tokens/revoke', input)
export const updateTokenScopes = (input: PortalTokenScopesRequest) => post<PortalTokenResult>(members + '/tokens/scopes', input)
/**
 * 改一把已有凭证的有效期。
 *
 * ★ `expires_at_ms: null` 表示长期有效，其余必须是未来时刻 —— 与签发共用
 *   同一条服务端校验。刻意与 `updateTokenScopes` 分成两个端点：改范围与
 *   改有效期是两件事，合成一个「更新凭证」请求会让只想续期的调用顺手带上 scopes。
 */
export const setTokenExpiry = (input: PortalTokenExpiryRequest) => post<PortalTokenResult>(members + '/tokens/expiry', input)
/**
 * ★ 物理删除一把凭证（appKey 管理页的「删除」）。
 *
 * ⚠️ 与 `revokeToken` 是两件事：吊销保留整行与历史归属，删除让这一行彻底消失。
 *   服务端只允许删**从未上报过、也没被审计引用**的凭证（`usage_event.report_token_id`
 *   是 RESTRICT 外键），其余情况返回 409 并说明原因 —— 所以它**不能**被做成
 *   「失败就当吊销处理」：那会把一句「这把 key 已经产生过用量」变成一个静默的降级。
 * ⚠️ 响应里没有 `token` 字段：行已经不存在了。
 */
export const deleteToken = (input: PortalTokenVersionRequest) => post<PortalMutationResult>(members + '/tokens/delete', input)
export const createGroup = (name: string) => post<PortalGroupResult>(root + '/groups', { name })
export const updateGroup = (input: PortalGroupVersionRequest & { name: string }) => post<PortalGroupResult>(root + '/groups/update', input)
export const updateGroupStatus = (input: PortalGroupVersionRequest & { status: 'active' | 'disabled' }) => post<PortalGroupResult>(root + '/groups/status', input)
/**
 * 供应商 / 模型归一化规则（v6 供应商，v12 追加模型）。
 *
 * ★ 这是**查询期**的展示映射，不是数据改写：配一条规则之后，看板里
 *   「按供应商 / 模型分组」的分组名立刻变，而明细里的原值列原样保留。
 *   所以这里没有「应用 / 回填」按钮，也不需要版本号做并发保护 ——
 *   一次设置就是使用者想要的结果（服务端按 `(scope, member_id, provider, model)` upsert）。
 *
 * ★ 一条规则只折叠一个维度：请求里 `model` 为空 = 折叠供应商名，
 *   有值 = 折叠模型名（此时 `provider` 可以是 `'*'`，表示任意供应商）。
 */
export const fetchProviderAliases = () => request<PortalProviderAliasListResponse>(root + '/provider-aliases')
export const setProviderAlias = (input: PortalSetProviderAliasRequest) => post<PortalProviderAliasResult>(root + '/provider-aliases', input)
export const setProviderAliasStatus = (input: PortalProviderAliasStatusRequest) => post<PortalProviderAliasResult>(root + '/provider-aliases/status', input)
export const deleteProviderAlias = (input: PortalProviderAliasIdRequest) => post<PortalMutationResult>(root + '/provider-aliases/delete', input)
/**
 * 项目归一化规则（v11）。
 *
 * ★ 与供应商归一化同类：**查询期**的展示映射，不是数据改写。配一条规则之后
 *   看板「按项目分组」的分组名立刻变，而 `usage_event.cwd` 原样保留，
 *   历史不需要任何回填。
 *
 * ⚠️ 有一处语义与供应商**刻意不同**，页面的文案必须说清：匹配是**目录前缀**
 *   （按路径分隔符边界），多条命中时**最长前缀优先**；没配规则的目录回落
 *   「目录最后一段」的旧口径。所以同一份数据两个人看到的项目分布可以不同
 *   （人员规则覆盖同前缀的全局规则）。
 */
export const fetchProjectAliases = () => request<PortalProjectAliasListResponse>(root + '/project-aliases')
export const setProjectAlias = (input: PortalSetProjectAliasRequest) => post<PortalProjectAliasResult>(root + '/project-aliases', input)
export const setProjectAliasStatus = (input: PortalProjectAliasStatusRequest) => post<PortalProjectAliasResult>(root + '/project-aliases/status', input)
export const deleteProjectAlias = (input: PortalProjectAliasIdRequest) => post<PortalMutationResult>(root + '/project-aliases/delete', input)
/**
 * 模型单价（v7）—— 费用统计的**唯一**计价来源。
 *
 * ★ 粒度是 `(provider, model)` 精确匹配，不是一个供应商一个价：
 *   同一个供应商下不同模型的价差常常在 10 倍以上，汇成一个价会让一半模型算错，
 *   而页面上只看得出「金额不对」，看不出是哪一半。
 * 🚨 金额一律是**整数微元 / 千 token**（1 微 = 1e-6 货币单位）。页面只负责
 *   把「货币单位 / 百万 token」换算成库里的这个整数（两者差 1000），**不参与任何计费算术**
 *   （口径与格式化都在 `shared/price.ts`）。
 * ⚠️ 四类单价必须分开填：`cacheRead` 通常比 `input` 便宜一个数量级，
 *   而它占总量的 94% 以上（铁律 2）—— 合成一个价等于让绝大部分用量算错。
 */
export const fetchModelPrices = () => request<PortalModelPriceListResponse>(root + '/pricing')
export const setModelPrice = (input: PortalSetModelPriceRequest) => post<PortalModelPriceResult>(root + '/pricing', input)
export const deleteModelPrice = (input: PortalModelPriceIdRequest) => post<PortalMutationResult>(root + '/pricing/delete', input)
