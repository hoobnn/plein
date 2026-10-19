/** 地址解析不依赖浏览器状态；损坏链接也必须能渲染恢复页面。 */
export type Route =
  | { name: 'home' }
  | { name: 'project'; id: string }
  | { name: 'canvas'; id: string }
  | { name: 'demo' }
  | { name: 'invalid' }

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '').split('?')[0]!
  if (!path || path === '/') return { name: 'home' }
  if (path === '/demo' || path === '/demo/') return { name: 'demo' }
  const match = /^\/(c|p)\/([^/]+)\/?$/.exec(path)
  if (!match) return { name: 'invalid' }
  try {
    const id = decodeURIComponent(match[2]!)
    return match[1] === 'c' ? { name: 'canvas', id } : { name: 'project', id }
  } catch {
    return { name: 'invalid' }
  }
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
