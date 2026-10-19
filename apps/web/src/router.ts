import { useSyncExternalStore } from 'react'
import { parseRoute, routeHash, type Route } from './routePath'
export { routeHash, type Route } from './routePath'

/** 极简 hash 路由：#/ 项目列表，#/p/<id> 打开项目（进入最近的画布），#/c/<id> 画布，#/demo 本地性能演示 */
let currentHash = location.hash
let current = parseRoute(currentHash)
const listeners = new Set<() => void>()
/** 地址变了就重新解析并通知；navigate 里同步调用，配合 flushSync 让页面切换能放进同一个 View Transition */
function sync() {
  if (location.hash === currentHash) return
  currentHash = location.hash
  current = parseRoute(currentHash)
  for (const fn of listeners) fn()
}
window.addEventListener('hashchange', sync)
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function useRoute() {
  return useSyncExternalStore(subscribe, () => current)
}

/** replace：替换当前历史记录（打开项目时跳到画布，返回键不该再落回跳转页） */
export function navigate(route: Route, opts: { replace?: boolean } = {}) {
  const hash = routeHash(route)
  if (opts.replace) location.replace(hash)
  else location.hash = hash
  sync()
}
