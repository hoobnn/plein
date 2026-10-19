import type { Project } from '@plein/protocol'
import type { UseQueryResult } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../ui/icons'
import { Popover } from '../../ui/Popover'
import { Presence } from '../../ui/Presence'

/** 项目名称始终说明读取状态；错误时可重试，缓存名称仍可用于改名。 */
export function ProjectTitle({
  query,
  onRename,
}: {
  query: UseQueryResult<Project>
  onRename(): void
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [retryError, setRetryError] = useState<Error | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
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
        trigger.current?.focus()
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
  const unavailable = !!error || !query.data
  const label = error ? (query.data ? '项目信息刷新失败' : '项目信息加载失败') : '项目信息正在加载'
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={unavailable ? label : undefined}
        aria-expanded={unavailable || anchor ? !!anchor : undefined}
        onClick={(event) =>
          unavailable ? setAnchor(anchor ? null : event.currentTarget) : onRename()
        }
        title={unavailable ? `${label}，点击查看` : '重命名项目'}
        className={`ui-bar-btn max-w-44 font-medium ${error ? 'text-danger' : 'text-ink'}`}
      >
        {unavailable &&
          (query.isFetching ? (
            <span className="ui-spinner size-3 flex-none" aria-hidden="true" />
          ) : (
            <Icon name="warning" size={14} />
          ))}
        <span className="truncate">
          {query.data?.title ?? (error ? '项目未加载' : '读取项目…')}
        </span>
      </button>
      <Presence>
        {anchor && (
          <Popover
            anchor={anchor}
            onClose={() => setAnchor(null)}
            label="项目信息"
            width={280}
            placement="below"
          >
            <div ref={panel} className="flex flex-col gap-3 p-3">
              {error ? (
                <p role="alert" className="break-words text-sm text-danger">
                  {error.message}
                </p>
              ) : (
                <p role="status" className="text-sm text-ink-muted">
                  正在读取项目信息…
                </p>
              )}
              <p className="break-words text-xs leading-5 text-ink-muted">
                {query.data
                  ? `当前使用已加载的项目名称「${query.data.title}」。可重试读取最新信息，也可继续改名。`
                  : '画布内容仍可编辑，项目信息恢复后可继续重命名项目。'}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-label="重新加载项目信息"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  disabled={query.isFetching}
                  onClick={() => void reload()}
                >
                  {query.isFetching ? '正在读取…' : '重新加载'}
                </button>
                {query.data && (
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary ui-btn-sm"
                    onClick={() => {
                      setAnchor(null)
                      onRename()
                    }}
                  >
                    重命名项目
                  </button>
                )}
              </div>
            </div>
          </Popover>
        )}
      </Presence>
    </>
  )
}
