export function LibraryReadStatus({
  loaded,
  loading,
  error,
  load,
}: {
  loaded: boolean
  loading: boolean
  error: string | null
  load(): Promise<void>
}) {
  if (error)
    return (
      <div
        role="alert"
        className="mb-3 flex flex-col items-start gap-2 rounded-lg border border-warning/20 bg-warning/5 p-3 text-xs text-warning"
      >
        <p className="w-full break-words">读取资产库失败：{error}</p>
        {loaded && <p>列表尚未更新，保留上次读取的结果。</p>}
        <button
          type="button"
          className="ui-btn ui-btn-secondary ui-btn-xs"
          onClick={() => void load()}
        >
          重新读取
        </button>
      </div>
    )
  if (loading)
    return (
      <p role="status" className="mb-3 px-2 py-2 text-xs text-ink-subtle">
        {loaded ? '正在刷新资产库…' : '正在读取资产库…'}
      </p>
    )
  return null
}
