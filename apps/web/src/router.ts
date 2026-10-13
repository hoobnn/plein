import { useSyncExternalStore } from 'react'

/** 极简 hash 路由：#/ 项目列表，#/p/<id> 打开项目（进入最近的画布），#/c/<id> 画布，#/demo 本地性能演示 */
export type Route =
  | { name: 'home' }
  | { name: 'project'; id: string }
  | { name: 'canvas'; id: string }
  | { name: 'demo' }

function parse(hash: string): Route {
  const path = hash.replace(/^#/, '')
  const m = /^\/c\/([^/?]+)/.exec(path)
  if (m) return { name: 'canvas', id: decodeURIComponent(m[1]!) }
  const p = /^\/p\/([^/?]+)/.exec(path)
  if (p) return { name: 'project', id: decodeURIComponent(p[1]!) }
  if (path.startsWith('/demo')) return { name: 'demo' }
  return { name: 'home' }
}

let currentHash = location.hash
let current = parse(currentHash)
const listeners = new Set<() => void>()
/** 地址变了就重新解析并通知；navigate 里同步调用，配合 flushSync 让页面切换能放进同一个 View Transition */
function sync() {
  if (location.hash === currentHash) return
  currentHash = location.hash
  current = parse(currentHash)
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

export function routeHash(route: Route) {
  switch (route.name) {
    case 'canvas':
      return `#/c/${encodeURIComponent(route.id)}`
    case 'project':
      return `#/p/${encodeURIComponent(route.id)}`
    case 'demo':
      return '#/demo'
    default:
      return '#/'
  }
}

/** replace：替换当前历史记录（打开项目时跳到画布，返回键不该再落回跳转页） */
export function navigate(route: Route, opts: { replace?: boolean } = {}) {
  const hash = routeHash(route)
  if (opts.replace) location.replace(hash)
  else location.hash = hash
  sync()
}
