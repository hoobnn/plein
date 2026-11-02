// Node 单测不导入 DOM 辅助；happy-dom 在业务模块订阅媒体查询之前安装稳定的 MQL。
if (typeof window !== 'undefined') {
  const { mockMatchMedia } = await import('./browser')
  mockMatchMedia((query) => query.startsWith('(prefers-reduced-motion'))
  // happy-dom 的 WAAPI cancel 会产生未处理的 AbortError；让 Motion 走它的 JS 动画后端。
  if (navigator.userAgent.includes('HappyDOM'))
    Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: undefined })
}

export {}
