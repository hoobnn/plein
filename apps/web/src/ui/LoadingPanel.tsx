/** 异步面板的轻量反馈；加载完成后由真实面板接管焦点和交互。 */
export function LoadingPanel({ label }: { label: string }) {
  return (
    <div className="pointer-events-none fixed inset-0 z-60 flex items-center justify-center p-4">
      <div
        role="status"
        className="w-full max-w-80 rounded-2xl border border-line bg-surface p-5 shadow-4"
      >
        <p className="flex items-center gap-2 text-sm text-ink-muted">
          <span className="ui-spinner size-4" aria-hidden="true" />
          {label}
        </p>
        <div aria-hidden="true" className="mt-4 flex flex-col gap-2">
          <div className="h-3 w-2/3 rounded bg-surface-2" />
          <div className="h-3 rounded bg-surface-2" />
          <div className="h-3 w-5/6 rounded bg-surface-2" />
        </div>
      </div>
    </div>
  )
}
