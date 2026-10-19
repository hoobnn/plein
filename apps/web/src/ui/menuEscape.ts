/** 菜单主动关闭时先声明按键归属，后续监听器不能再用变化后的 DOM 判断同一次 Esc。 */
const owned = new WeakSet<Event>()
export const claimMenuEscape = (event: Event) => {
  owned.add(event)
}
export const isMenuEscape = (event: Event) => owned.has(event)

/** Base UI 已关闭的菜单不再拦截；Presence 的退场菜单卸载前仍属于当前层。 */
export const hasMenuEscapeLayer = () =>
  !!document.querySelector(
    '.ui-menu:not([data-closed]), .ui-menu[data-closing], [role="combobox"][aria-expanded="true"]',
  )
