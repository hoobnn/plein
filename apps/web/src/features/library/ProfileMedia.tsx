import { PROFILE_LIMITS } from '@plein/nodes'
import { createContext, type ReactNode, useContext, useRef, useState } from 'react'
import { Icon } from '../../ui/icons'
import type { CanvasMedia } from './canvas'
import { CanvasPick, thumb, uploadAll, UploadFeedback, useLibraryFieldFocus } from './LibraryFields'
import type { HeroControl } from './profile.types'
import type { UploadNotice } from './uploadBatch'

export const ProfileUploadContext = createContext<{
  pending: boolean
  onBusyChange(busy: boolean): void
}>({ pending: false, onBusyChange: () => {} })

const ImageAttempts = createContext<{
  attempts: Record<string, number>
  retry(id: string): void
}>({ attempts: {}, retry: () => {} })

export function ProfileImageScope({ children }: { children: ReactNode }) {
  const [attempts, setAttempts] = useState<Record<string, number>>({})
  return (
    <ImageAttempts.Provider
      value={{
        attempts,
        retry: (id) => setAttempts((old) => ({ ...old, [id]: (old[id] ?? 0) + 1 })),
      }}
    >
      {children}
    </ImageAttempts.Provider>
  )
}

export function ProfileCover({ id }: { id: string }) {
  const { attempts } = useContext(ImageAttempts)
  const token = `${id}:${attempts[id] ?? 0}`
  const current = useRef(token)
  current.current = token
  const [failed, setFailed] = useState<string>()
  const hint = '参考图加载失败，进入编辑后重试'
  return failed === token ? (
    <span role="img" aria-label={hint} title={hint} className="lib-cover-error">
      <Icon name="warning" size={16} />
      <span aria-hidden="true">加载失败</span>
    </span>
  ) : (
    <img
      key={token}
      src={thumb(id)}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => {
        if (current.current === token) setFailed(token)
      }}
    />
  )
}

function ProfileImage({ id, hero, onRemove }: { id: string; hero: HeroControl; onRemove(): void }) {
  const group = useRef<HTMLDivElement>(null)
  const { attempts, retry } = useContext(ImageAttempts)
  const attempt = attempts[id] ?? 0
  const [failed, setFailed] = useState<number>()
  const current = useRef(attempt)
  current.current = attempt
  return (
    <div
      ref={group}
      role="group"
      aria-label="档案参考图"
      tabIndex={-1}
      className="lib-strip-tile lib-focus-region group"
      onPointerEnter={() => hero.onPreview(id)}
      onPointerLeave={() => hero.onPreview(null)}
    >
      {failed === attempt ? (
        <div className="flex h-full flex-col items-center justify-end pb-1 text-xs text-ink-subtle">
          <span role="status">加载失败</span>
          <button
            type="button"
            aria-label="重新加载图片"
            className="ui-btn ui-btn-quiet ui-btn-xs"
            onClick={(event) => {
              if (document.activeElement === event.currentTarget) group.current?.focus()
              retry(id)
            }}
          >
            <Icon name="retry" size={12} />
            重试
          </button>
        </div>
      ) : (
        <img
          key={attempt}
          src={thumb(id)}
          alt=""
          draggable={false}
          onError={() => {
            if (attempt === current.current) setFailed(attempt)
          }}
        />
      )}
      <button
        type="button"
        aria-label="移除"
        title="移除"
        onClick={onRemove}
        className="ui-btn ui-btn-quiet ui-btn-xs ui-icon-btn absolute top-1 right-1 bg-float opacity-0 group-hover:opacity-100 focus:opacity-100"
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  )
}

/** 最多 4 张的参考图条：72 小图，悬停换大图 */
export function ImageStrip({
  label,
  hint,
  images,
  media,
  hero,
  onChange,
}: {
  label: string
  hint?: string
  images: string[]
  media: CanvasMedia[]
  hero: HeroControl
  onChange(next: string[]): void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const focus = useLibraryFieldFocus()
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<UploadNotice | null>(null)
  const uploads = useContext(ProfileUploadContext)
  const room = PROFILE_LIMITS.images - images.length
  const add = (ids: string[]) =>
    onChange([...new Set([...images, ...ids])].slice(0, PROFILE_LIMITS.images))
  const upload = async (files: File[]) => {
    if (!files.length || busy || uploads.pending) return
    if (focus.props.ref.current?.contains(document.activeElement)) focus.park()
    setBusy(true)
    uploads.onBusyChange(true)
    setFeedback(null)
    try {
      const result = await uploadAll(files, 'image', { capacity: room, used: images })
      if (result.ids.length) add(result.ids)
      setFeedback(result)
    } catch (err) {
      setFeedback({ message: (err as Error).message, failed: true })
    } finally {
      setBusy(false)
      uploads.onBusyChange(false)
    }
  }
  return (
    <div {...focus.props} role="group" aria-label={label} className="ui-field lib-focus-region">
      <span className="ui-label flex min-w-0 items-baseline gap-2" title={hint}>
        <span className="flex-none">{label}</span>
        <span className="font-normal text-ink-subtle tabular-nums">
          {images.length}/{PROFILE_LIMITS.images}
        </span>
        {hint && <span className="truncate font-normal text-ink-subtle">{hint}</span>}
      </span>
      <div className="flex flex-wrap gap-2">
        {images.map((id) => (
          <ProfileImage
            key={id}
            id={id}
            hero={hero}
            onRemove={() => {
              focus.park()
              onChange(images.filter((x) => x !== id))
            }}
          />
        ))}
        {room > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => ref.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              void upload([...e.dataTransfer.files])
            }}
            className="ui-drop-tile lib-strip-add"
          >
            <Icon name={busy ? 'upload' : 'plus'} size={16} />
            {busy ? '上传中' : '上传'}
          </button>
        )}
        {room > 0 && (
          <CanvasPick
            disabled={busy || uploads.pending || room <= 0}
            media={media}
            type="image"
            multiple
            taken={images}
            onPick={(id) => {
              if (room === 1) focus.park()
              setFeedback(null)
              add([id])
            }}
          />
        )}
      </div>
      <UploadFeedback value={feedback} />
      <input
        ref={ref}
        type="file"
        accept="image/*"
        multiple
        hidden
        disabled={busy || uploads.pending || room <= 0}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          void upload(files)
        }}
      />
    </div>
  )
}
