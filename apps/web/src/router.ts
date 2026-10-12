import { useSyncExternalStore } from 'react'

/** 极简 hash 路由：#/ 画布列表，#/c/<id> 画布，#/demo 本地性能演示 */
export type Route = { name: 'home' } | { name: 'canvas'; id: string } | { name: 'demo' }

function parse(hash: string): Route {
  const path = hash.replace(/^#/, '')
  const m = /^\/c\/([^/?]+)/.exec(path)
  if (m) return { name: 'canvas', id: decodeURIComponent(m[1]!) }
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

export function navigate(route: Route) {
  location.hash =
    route.name === 'canvas'
      ? `/c/${encodeURIComponent(route.id)}`
      : route.name === 'demo'
        ? '/demo'
        : '/'
}
