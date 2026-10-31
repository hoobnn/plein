import type { Canvas } from '@plein/protocol'
import type { UseQueryResult } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../ui/icons'
import { Popover } from '../../ui/Popover'
import { Presence } from '../../ui/Presence'

/** 元数据读取失败不挡住画布，项目相关操作在信息恢复后继续。 */
export function CanvasInfo({ query }: { query: UseQueryResult<Canvas> }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [retryError, setRetryError] = useState<Error | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const focusFrame = useRef<number | undefined>(undefined)
  const error = query.error ?? retryError
  const loaded = !!query.data && !error && !query.isFetching
  useEffect(
    () => () => {
      if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current)
    },
    [],
  )
  useEffect(() => {
    if (!loaded || !anchor) return
    const popup = panel.current?.closest('[role="dialog"]')
    const restore =
      !!popup &&
      (popup.contains(document.activeElement) || document.activeElement === document.body)
    setAnchor(null)
    focusFrame.current = requestAnimationFrame(() => {
      if (
        restore &&
        (document.activeElement === document.body || popup?.contains(document.activeElement))
      )
        document.querySelector<HTMLButtonElement>('button[aria-label="切换画布"]')?.focus()
    })
  }, [loaded, anchor])

  const reload = async () => {
    if (query.isFetching) return
    setRetryError(query.error)
    try {
      await query.refetch({ throwOnError: false })
    } finally {
      setRetryError(null)
    }
  }
  if (query.data && !error && !anchor) return null
  const label = error ? (query.data ? '画布信息刷新失败' : '画布信息加载失败') : '画布信息正在加载'
  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-expanded={!!anchor}
        title={`${label}，点击查看`}
        className={`ui-bar-btn gap-1.5 ${error ? 'text-danger' : ''}`}
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
      >
        {query.isFetching ? (
          <span className="ui-spinner size-3" aria-hidden="true" />
        ) : (
          <Icon name="warning" size={14} />
        )}
        <span>{error ? (query.data ? '信息未更新' : '信息未加载') : '读取信息…'}</span>
      </button>
      <Presence>
        {anchor && (
          <Popover
            anchor={anchor}
            onClose={() => setAnchor(null)}
            label="画布信息"
            width={280}
            placement="below"
          >
            <div ref={panel} className="flex flex-col gap-3 p-(--panel-pad)">
              {error ? (
                <p role="alert" className="break-words text-sm text-danger">
                  {error.message}
                </p>
              ) : (
                <p role="status" className="text-sm text-ink-muted">
                  正在读取画布信息…
                </p>
              )}
              <p className="ui-note text-ink-muted">
                {query.data
                  ? '继续使用已加载的信息，项目相关操作仍可使用。可重试读取最新信息。'
                  : '画布内容仍可编辑；项目筛选、默认素材归属和检查点在信息读取成功后恢复。'}
              </p>
              <button
                type="button"
                aria-label="重新加载画布信息"
                className="ui-btn ui-btn-secondary ui-btn-sm self-start"
                disabled={query.isFetching}
                onClick={() => void reload()}
              >
                {query.isFetching ? '正在读取…' : '重新加载'}
              </button>
            </div>
          </Popover>
        )}
      </Presence>
    </>
  )
}
