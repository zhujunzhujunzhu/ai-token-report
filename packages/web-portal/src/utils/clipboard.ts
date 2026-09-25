/**
 * 复制文本到剪贴板（管理页用）。
 *
 * ## 为什么要单独一个函数
 *
 * `navigator.clipboard` **只在安全上下文可用**：`https://` 或 `localhost`。
 * 而部门服务端的典型部署是 `http://<内网 IP>:8787` —— 恰好不是安全上下文，
 * 此时 `navigator.clipboard` 是 `undefined`（或调用即 reject）。
 * 页面若只写 `await navigator.clipboard.writeText(...)`，管理员按「复制」
 * 会**毫无反应**，然后手动去拖选那串 token（还容易少选一个字符）。
 *
 * 因此降级路径是必需的：把对应元素整段选中，让使用者按 Ctrl+C。
 * 返回值告诉调用方走的是哪条路，页面据此给出不同提示 ——
 * 一句「已复制」而实际没复制，是这里最容易犯的错。
 */

/**
 * 复制文本。
 *
 * @param text 要复制的文本（token）
 * @param selectTargetId 降级时整段选中的元素 id
 * @returns 是否真的写进了剪贴板
 */
export async function copyText(
  text: string,
  selectTargetId?: string,
): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 落到下面的降级路径 */
  }

  if (selectTargetId) selectTextById(selectTargetId)
  return false
}

/** 把某个元素的文本整段选中（降级路径：让使用者按 Ctrl+C）。 */
function selectTextById(id: string): void {
  if (typeof document === 'undefined') return
  const el = document.getElementById(id)
  if (!el) return
  const range = document.createRange()
  range.selectNodeContents(el)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}
