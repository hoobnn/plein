import { useState } from 'react'
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

/** 重试与选择是两个独立操作；失败的缩略图仍可选择，重试不改变素材。 */
export function LibraryThumbnail(props: ThumbnailProps) {
  const [attempt, setAttempt] = useState(0)
  return (
    <ThumbnailAttempt
      key={`${props.src}:${attempt}`}
      {...props}
      onRetry={() => setAttempt((n) => n + 1)}
    />
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
}: ThumbnailProps & { onRetry(): void }) {
  const [failed, setFailed] = useState(false)
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
    <div className="relative size-full">
      {onSelect ? (
        <button
          type="button"
          aria-label={label}
          title={title ?? label}
          aria-pressed={!!selected}
          disabled={disabled || selected}
          onClick={onSelect}
          className={failed ? 'block h-[calc(100%-24px)] w-full' : 'block size-full'}
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
          onClick={onRetry}
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
    </div>
  )
}

/** 每次来源变化或重试都使用新的播放实例，旧实例错误不会污染新视频。 */
export function ReferenceVideo({ src, disabled }: { src: string; disabled?: boolean }) {
  const [attempt, setAttempt] = useState(0)
  return (
    <VideoAttempt
      key={`${src}:${attempt}`}
      src={src}
      disabled={disabled}
      onRetry={() => setAttempt((n) => n + 1)}
    />
  )
}

function VideoAttempt({
  src,
  disabled,
  onRetry,
}: {
  src: string
  disabled?: boolean
  onRetry(): void
}) {
  const [failed, setFailed] = useState(false)
  if (failed)
    return (
      <div
        role="alert"
        className="flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-lg bg-surface-2 p-3 text-sm text-ink-subtle"
      >
        <span>视频加载失败</span>
        <button
          type="button"
          disabled={disabled}
          onClick={onRetry}
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
      controls
      preload="metadata"
      onError={() => setFailed(true)}
      className="max-h-56 w-full rounded-lg bg-black"
    />
  )
  // oxlint-enable jsx-a11y/media-has-caption
}
