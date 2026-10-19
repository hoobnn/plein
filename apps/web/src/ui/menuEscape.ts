/** 菜单主动关闭时先声明按键归属，后续监听器不能再用变化后的 DOM 判断同一次 Esc。 */
const owned = new WeakSet<Event>()
export const claimMenuEscape = (event: Event) => {
  owned.add(event)
}
export const isMenuEscape = (event: Event) => owned.has(event)
