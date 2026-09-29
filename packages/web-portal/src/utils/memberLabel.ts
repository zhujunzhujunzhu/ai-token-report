/**
 * 人员展示标签（appKey 管理页的发放下拉与列表共用）。
 *
 * 人员与分组是**多对多**：一个人可以同时属于多个分组，所以这里用「、」拼接，
 * 而不是只取一个分组名。空数组表示未分组，是否显示「未分组」由调用方决定
 * （列表列里要显示，标签里不必）。
 *
 * ⚠️ 下拉与列表必须用同一个拼法：两处各写一遍的话，同一个人在两处会显示成
 *   两个样子，使用者会以为自己选错了人。
 */
import type { PortalMember, PortalMemberGroupRef } from '@ai-token-report/shared'

export function groupLabel(groups: PortalMemberGroupRef[]): string {
  return groups.map((group) => group.name).join('、')
}

/** 「姓名（分组）」；未分组时只留姓名。 */
export function memberLabel(member: PortalMember): string {
  const groups = groupLabel(member.groups)
  return member.name + (groups ? `（${groups}）` : '')
}