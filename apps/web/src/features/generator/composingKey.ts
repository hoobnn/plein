/**
 * 组字中的按键判断。
 *
 * 中文输入法组字时，Enter 是「确认候选词」而不是「提交」，
 * 浏览器这时会带 isComposing 或 keyCode 229。判断漏掉这两种信号，
 * 用户在候选词还没选完时就会把提示词提交出去。
 */
export function composingKey(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return !!event.isComposing || event.keyCode === 229
}
