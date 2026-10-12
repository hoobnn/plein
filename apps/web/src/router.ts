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

let current = parse(location.hash)
const subscribe = (fn: () => void) => {
  const on = () => {
    current = parse(location.hash)
    fn()
  }
  window.addEventListener('hashchange', on)
  return () => window.removeEventListener('hashchange', on)
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
}
