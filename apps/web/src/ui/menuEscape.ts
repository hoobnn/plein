/** 菜单主动关闭时先声明按键归属，后续监听器不能再用变化后的 DOM 判断同一次 Esc。 */
const owned = new WeakSet<Event>()
export const claimMenuEscape = (event: Event) => {
  owned.add(event)
}
export const isMenuEscape = (event: Event) => owned.has(event)

/** 已关闭或被前景弹窗隐藏的后台菜单不拦截；当前层退场中的菜单仍占用本次 Esc。 */
export const hasMenuEscapeLayer = () =>
  [
    ...document.querySelectorAll(
      '.ui-menu:not([data-closed]), .ui-menu[data-closing], [role="combobox"][aria-expanded="true"]',
    ),
  ].some((element) => !element.closest('[aria-hidden="true"], [inert]'))
