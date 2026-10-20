/** 菜单主动关闭时先声明按键归属，后续监听器不能再用变化后的 DOM 判断同一次 Esc。 */
const owned = new WeakSet<Event>()
export const claimMenuEscape = (event: Event) => {
  owned.add(event)
}
export const isMenuEscape = (event: Event) => owned.has(event)

/** 后台菜单不拦截；内联结果列表属于面板正文，当前层退场菜单仍占用本次 Esc。 */
export const hasMenuEscapeLayer = () =>
  [
    ...document.querySelectorAll(
      '.ui-menu:not([data-closed]), .ui-menu[data-closing], [role="combobox"][aria-expanded="true"]:not([data-plein-inline-list])',
    ),
  ].some((element) => !element.closest('[aria-hidden="true"], [inert]'))
