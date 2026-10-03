/**
 * 角色页的纯判断：权限清单怎么显示、列表怎么过滤、哪些角色能被分配。
 *
 * ★ 抽出来是为了能被 `bun test` 直接断言。渲染层（`RolesView.vue`）在 SSR 下
 *   **不会渲染 `el-table` 的列与行**（Element Plus 的表头与单元格由客户端渲染，
 *   服务端只输出空 `<tr>`），所以「停用角色不该出现在分配下拉里」「未知权限码要
 *   回退成能看懂的标签」这类判断若写在模板里，就只能靠人手点一遍才能发现坏掉 ——
 *   而它们恰恰是最容易悄悄失效的那一类。
 */
import type { PortalPermission, PortalRole } from '@ai-token-report/shared'

/**
 * 权限码的中文说明。
 *
 * ⚠️ 这只是**显示层**的润色，不是权限真源：真正的可勾选清单来自服务端
 *   `permissions` 表（随角色目录一起下发）。所以查不到时必须能回退，
 *   而不是把这一项从清单里抹掉 —— 那会让「数据库里有、页面勾不上」无法察觉。
 */
export const ROLE_PERMISSION_LABELS: Record<string, string> = {
  'identity:read': '校验上报身份',
  'usage:write': '上报个人用量',
  'stats:read': '查看用量统计',
  'members:read': '查看人员',
  'members:manage': '管理人员',
  'tokens:manage': '管理上报凭证',
  'accounts:manage': '管理登录账号',
  'roles:read': '查看角色',
  'roles:assign': '分配角色',
  'groups:read': '查看分组',
  'groups:manage': '管理分组',
  'audit:read': '查看管理记录',
  // ⚠️ `providers:*`（v6）与 `cost:read` / `pricing:manage`（v7）**必须各有一行**。
  //   缺了它不会报错：服务端 seed 的 `description` 就是权限码本身，
  //   于是角色管理页把 `providers:read` 原样显示出来，
  //   而使用者会以为「这个权限是给机器看的」，不知道该不该勾。
  'providers:read': '查看供应商与模型归一化规则',
  'providers:manage': '管理供应商与模型归一化规则',
  'cost:read': '查看用量费用',
  'pricing:manage': '管理模型单价',
}

/** 权限码 → 展示标签：中文说明 → 服务端描述 → 码本身（逐级回退，不吞掉信息）。 */
export function permissionLabel(code: string, description?: string | null): string {
  return ROLE_PERMISSION_LABELS[code] ?? (description?.trim() ? description.trim() : code)
}

export interface PermissionOption {
  code: string
  label: string
}

/** 勾选项：值与展示分开，`value` 永远是权限码（提交上去的就是它）。 */
export function permissionOptions(permissions: PortalPermission[]): PermissionOption[] {
  return permissions.map((permission) => ({
    code: permission.code,
    label: permissionLabel(permission.code, permission.description),
  }))
}

export interface RoleFilter {
  search: string
  status: string
}

/** 状态筛选 + 名称/标识关键字过滤。空条件恒为真，所以「全部」是一个筛选值而不是特例分支。 */
export function filterRoles(roles: PortalRole[], filter: RoleFilter): PortalRole[] {
  const keyword = filter.search.trim().toLowerCase()
  return roles.filter((role) =>
    (!filter.status || role.status === filter.status) &&
    (!keyword || [role.name, role.code].join(' ').toLowerCase().includes(keyword)))
}

/**
 * 可以被分配给人的角色：**只含启用**的。
 *
 * ⚠️ 停用角色一旦列进下拉，使用者选中后会拿到服务端 400，而页面看起来只是「没保存上」。
 *   真正的门禁在服务端；这里少列一个选项，是为了不制造那次必然失败的点击。
 */
export function assignableRoles(roles: PortalRole[]): PortalRole[] {
  return roles.filter((role) => role.status === 'active')
}