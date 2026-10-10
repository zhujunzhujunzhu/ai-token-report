/** 助手输入框快捷键：选字回车交给输入法，按住回车不重复提交。 */
export function handleAssistantComposerKeydown(
  event: Pick<KeyboardEvent, 'key' | 'altKey' | 'isComposing' | 'keyCode' | 'repeat' | 'preventDefault'>,
  actions: { send: () => void; newline: () => void },
): void {
  // ★ 部分输入法结束选字时 isComposing 已变为 false，仍用 229 标记当前事件。
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  if (event.altKey) actions.newline()
  else if (!event.repeat) actions.send()
}
