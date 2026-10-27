import { useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '../../ui/icons'

interface ThumbnailProps {
  src: string
  label: string
  title?: string
  contain?: boolean
  selected?: boolean
  disabled?: boolean
  onSelect?(): void
}

/** 档案参考条：悬停只预览，点击才固定；恢复小图不改变大图选择。 */
export function ReferenceThumbnail({
  src,
  label,
  selected,
  onPreview,
  onSelect,
}: {
  src: string
  label: string
  selected: boolean
  onPreview(active: boolean): void
  onSelect(): void
}) {
  const [attempt, setAttempt] = useState(0)
  const token = `${src}:${attempt}`
  const current = useRef(token)
  current.current = token
  const [failedToken, setFailedToken] = useState<string>()
  const failed = failedToken === token
  const select = useRef<HTMLButtonElement>(null)
  const previewing = useRef(false)
  return (
    <div className="lib-hero-thumb" data-failed={failed || undefined}>
      <button
        ref={select}
        type="button"
        aria-label={label}
        title={failed ? `${label}加载失败，仍可预览大图` : label}
        aria-pressed={selected}
        onPointerMove={() => {
          // 重试按钮消失会使预览区出现在原指针下面；仅真实移动才开始悬停。
          if (previewing.current) return
          previewing.current = true
          onPreview(true)
        }}
        onPointerLeave={() => {
          previewing.current = false
          onPreview(false)
        }}
        onClick={onSelect}
        className="lib-hero-thumb-preview"
      >
        {failed ? (
          <span role="img" aria-label={`${label}加载失败`} className="text-xs text-ink-subtle">
            加载失败
          </span>
        ) : (
          <img
            key={token}
            src={src}
            alt=""
            draggable={false}
            onError={() => {
              if (current.current === token) setFailedToken(token)
            }}
          />
        )}
      </button>
      {failed && (
        <button
          type="button"
          aria-label={`重新加载${label}`}
          className="ui-btn ui-btn-xs ui-btn-quiet lib-hero-thumb-retry"
          onClick={() => {
            setAttempt((n) => n + 1)
            select.current?.focus()
          }}
        >
          重试
        </button>
      )}
    </div>
  )
}

/** 重试与选择是两个独立操作；失败的缩略图仍可选择，重试不改变素材。 */
export function LibraryThumbnail(props: ThumbnailProps) {
  const [attempt, setAttempt] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const restore = useRef(false)
  useLayoutEffect(() => {
    const wanted = restore.current
    restore.current = false
    if (wanted && document.activeElement === document.body) {
      // 自己判断可用，不用 :enabled 选择器：它依赖浏览器的伪类实现，测试环境里并不可靠。
      const pressed = [
        ...(root.current?.querySelectorAll<HTMLButtonElement>('button[aria-pressed]') ?? []),
      ]
      ;(pressed.find((button) => !button.disabled) ?? root.current)?.focus()
    }
  }, [attempt])
  return (
    <div
      ref={root}
      role="group"
      aria-label={props.label}
      tabIndex={-1}
      className="lib-focus-region relative size-full rounded-[inherit]"
    >
      <ThumbnailAttempt
        key={`${props.src}:${attempt}`}
        {...props}
        onRetry={(button) => {
          restore.current = document.activeElement === button
          setAttempt((n) => n + 1)
        }}
      />
    </div>
  )
}

function ThumbnailAttempt({
  src,
  label,
  title,
  contain,
  selected,
  disabled,
  onSelect,
  onRetry,
}: ThumbnailProps & { onRetry(button: HTMLButtonElement): void }) {
  const [failed, setFailed] = useState(false)
  // 缩略图加载失败不代表素材不能用，按钮仍可选择；要说清楚，别让用户误删素材。
  const hint = failed ? `${title ?? label}加载失败，仍可选用` : title
  const content = failed ? (
    <span
      role="img"
      aria-label={`${label}加载失败`}
      className={`flex size-full items-center justify-center text-xs text-ink-subtle ${onSelect ? '' : 'pb-6'}`}
    >
      加载失败
    </span>
  ) : (
    <img
      src={src}
      alt={onSelect ? '' : label}
      draggable={false}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`size-full ${contain ? 'object-contain' : 'object-cover'}`}
    />
  )
  return (
    <>
      {onSelect ? (
        <button
          type="button"
          aria-label={label}
          title={hint ?? label}
          aria-pressed={!!selected}
          disabled={disabled || selected}
          onClick={onSelect}
          className={`lib-focus-region ${failed ? 'block h-[calc(100%-24px)] w-full' : 'block size-full'}`}
        >
          {content}
        </button>
      ) : (
        content
      )}
      {failed && (
        <button
          type="button"
          aria-label={`重新加载${label}`}
          disabled={disabled}
          onClick={(event) => onRetry(event.currentTarget)}
          className="ui-btn ui-btn-xs ui-btn-quiet absolute inset-x-0 bottom-0.5 mx-auto w-fit"
        >
          重试
        </button>
      )}
      {selected && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-ink">
          <Icon name="check" size={16} />
        </span>
      )}
    </>
  )
}

/** 每次来源变化或重试都使用新的播放实例，旧实例错误不会污染新视频。 */
export function ReferenceVideo({ src, disabled }: { src: string; disabled?: boolean }) {
  const [attempt, setAttempt] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const restore = useRef(false)
  useLayoutEffect(() => {
    const wanted = restore.current
    restore.current = false
    if (wanted && document.activeElement === document.body)
      root.current?.querySelector<HTMLElement>('video, button')?.focus()
  }, [attempt])
  return (
    <div ref={root}>
      <VideoAttempt
        key={`${src}:${attempt}`}
        src={src}
        disabled={disabled}
        onRetry={(button) => {
          restore.current = document.activeElement === button
          setAttempt((n) => n + 1)
        }}
      />
    </div>
  )
}

function VideoAttempt({
  src,
  disabled,
  onRetry,
}: {
  src: string
  disabled?: boolean
  onRetry(button: HTMLButtonElement): void
}) {
  const [failed, setFailed] = useState(false)
  const retry = useRef<HTMLButtonElement>(null)
  const restore = useRef(false)
  useLayoutEffect(() => {
    if (!failed) return
    const wanted = restore.current
    restore.current = false
    if (wanted && document.activeElement === document.body) retry.current?.focus()
  }, [failed])
  if (failed)
    return (
      <div
        role="alert"
        className="flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-lg bg-surface-2 p-3 text-sm text-ink-subtle"
      >
        <span>视频加载失败</span>
        <button
          ref={retry}
          type="button"
          disabled={disabled}
          onClick={(event) => onRetry(event.currentTarget)}
          className="ui-btn ui-btn-secondary ui-btn-sm"
        >
          重新加载参考视频
        </button>
      </div>
    )
  // oxlint-disable jsx-a11y/media-has-caption -- 用户参考视频没有可用字幕轨
  return (
    <video
      src={src}
      aria-label="参考视频"
      tabIndex={0}
      controls
      preload="metadata"
      onError={(event) => {
        restore.current = document.activeElement === event.currentTarget
        setFailed(true)
      }}
      className="max-h-56 w-full rounded-lg bg-black"
    />
  )
  // oxlint-enable jsx-a11y/media-has-caption
}
