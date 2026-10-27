// Node 单测不导入 DOM 辅助；happy-dom 在业务模块订阅媒体查询之前安装稳定的 MQL。
if (typeof window !== 'undefined') {
  const { mockMatchMedia } = await import('./browser')
  mockMatchMedia((query) => query === '(prefers-reduced-motion: reduce)')
}

export {}
