import { Component, type ReactNode } from 'react'

/** 动态模块失败后 React.lazy 会保留拒绝结果，刷新才能重新取得当前版本。 */
export class ErrorBoundary extends Component<
  { children: ReactNode; reload?: () => void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-ink-muted">
        <p role="alert">页面加载失败：{this.state.error.message}</p>
        <p>请刷新页面后重新打开。</p>
        <button
          type="button"
          className="ui-btn ui-btn-secondary"
          onClick={() => {
            if (this.props.reload) this.props.reload()
            else window.location.reload()
          }}
        >
          刷新页面
        </button>
      </div>
    )
  }
}
