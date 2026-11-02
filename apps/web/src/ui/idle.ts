/** 首屏渲染完成后的空闲预取；失败只影响本次预取，真实打开时仍会重试。 */
export function prefetchIdle(loaders: Array<() => Promise<unknown>>) {
  const run = () => {
    for (const load of loaders) void load().catch(() => {})
  }
  if ('requestIdleCallback' in window) {
    const id = window.requestIdleCallback(run)
    return () => window.cancelIdleCallback(id)
  }
  const id = setTimeout(run, 0)
  return () => clearTimeout(id)
}
