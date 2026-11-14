import { useSyncExternalStore } from 'react'
import { parseRoute, routeHash, type Route } from './routePath'
export { routeHash, type Route } from './routePath'

/** 极简 hash 路由：#/ 项目列表，#/p/<id> 打开项目（进入最近的画布），#/c/<id> 画布，#/demo 本地性能演示 */
let currentHash = location.hash
let current = parseRoute(currentHash)
const listeners = new Set<() => void>()

/**
 * 离开保护：还有没保存的本机改动时，先用 blocks 判断要不要问，再让 confirm 问用户。
 * 历史后退没法阻止地址变化，sync 会先把地址恢复再问。
 */
export interface LeaveGuard {
  blocks(next: Route): boolean
  confirm(next: Route): Promise<boolean>
}
let leaveGuard: LeaveGuard | null = null
/** 额外离开保护（如未落盘的工作台草稿）；按登记顺序与文档 guard 一起询问。 */
const registeredGuards = new Map<symbol, LeaveGuard>()
/** 同一个目标只问一次；用户还在决定时重复点击不再叠对话框 */
let reviewing: { hash: string; promise: Promise<boolean> } | null = null
/** 用户已经确认过的目标地址：地址真正变过去时放行，不再问第二次 */
let approvedHash: string | null = null

function activeGuards(): LeaveGuard[] {
  return leaveGuard ? [leaveGuard, ...registeredGuards.values()] : [...registeredGuards.values()]
}

export function setLeaveGuard(guard: LeaveGuard | null) {
  leaveGuard = guard
  if (!guard && !registeredGuards.size) reviewing = null
}

/** 登记一个不会替换文档 dirty guard 的附加离开保护；返回注销函数。 */
export function registerLeaveGuard(guard: LeaveGuard) {
  const token = Symbol('leave-guard')
  registeredGuards.set(token, guard)
  return () => {
    registeredGuards.delete(token)
    if (!registeredGuards.size && !leaveGuard) reviewing = null
  }
}

/** 这次跳转会不会被离开保护拦下来；需要时应先自己收好动画再调用 navigate */
export function leaveBlocked(next: Route) {
  return activeGuards().some((guard) => guard.blocks(next)) && routeHash(next) !== currentHash
}

/** 地址变了就重新解析并通知；navigate 里同步调用，配合 flushSync 让页面切换能放进同一个 View Transition */
function sync() {
  if (location.hash === currentHash) return
  const next = parseRoute(location.hash)
  if (approvedHash === location.hash) {
    approvedHash = null
    apply(next)
    return
  }
  if (activeGuards().some((guard) => guard.blocks(next))) {
    // 历史后退已经改了地址：先恢复，页面不切，问过用户再决定
    const from = currentHash
    history.pushState(history.state, '', from)
    void askLeave(next).then((go) => {
      if (go && useRouteAt(from)) navigateNow(next, {})
    })
    return
  }
  apply(next)
}

function useRouteAt(hash: string) {
  return location.hash === hash
}

function apply(next: Route) {
  currentHash = location.hash
  current = next
  for (const fn of listeners) fn()
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function useRoute() {
  return useSyncExternalStore(subscribe, () => current)
}

function askLeave(next: Route) {
  const hash = routeHash(next)
  if (reviewing?.hash === hash) return reviewing.promise
  const promise = (async () => {
    for (const guard of activeGuards()) {
      if (!guard.blocks(next)) continue
      if (!(await guard.confirm(next))) return false
    }
    return true
  })().finally(() => {
    if (reviewing?.promise === promise) reviewing = null
  })
  reviewing = { hash, promise }
  return promise
}

/** replace：替换当前历史记录（打开项目时跳到画布，返回键不该再落回跳转页）；force：文档已删除等必须离开的路径 */
export function navigate(route: Route, opts: { replace?: boolean; force?: boolean } = {}) {
  if (!opts.force && routeHash(route) !== currentHash && leaveBlocked(route)) {
    void askLeave(route).then((go) => {
      if (go) navigateNow(route, opts)
    })
    return
  }
  navigateNow(route, opts)
}

function navigateNow(route: Route, opts: { replace?: boolean } = {}) {
  const hash = routeHash(route)
  approvedHash = hash
  if (opts.replace) location.replace(hash)
  else location.hash = hash
  sync()
  // 目标就是当前地址时没有 hashchange 来消费这次放行，别留给之后的跳转
  if (location.hash === currentHash) approvedHash = null
}

window.addEventListener('hashchange', sync)
