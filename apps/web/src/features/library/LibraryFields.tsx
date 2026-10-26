import type { LibraryKindSpec } from '@plein/nodes'
import type { LibraryImage } from '@plein/protocol'
import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { api, assetUrls } from '../../api/client'
import type { CanvasMedia } from './canvas'
import { Icon } from '../../ui/icons'
import { Popover } from '../../ui/Popover'
import { Presence } from '../../ui/Presence'
import { LibraryThumbnail, ReferenceVideo } from './LibraryMedia'
import { uploadBatch, type UploadNotice } from './uploadBatch'

/** 资产库编辑页的图片字段：上传、从画布选、槽位与参考视频 */

/** 在同步选择移除其入口之前，先把键盘位置停在仍会保留的字段内。 */
export function useLibraryFieldFocus() {
  const ref = useRef<HTMLDivElement>(null)
  return {
    props: { ref, tabIndex: -1 },
    park: () => ref.current?.focus({ preventScroll: true }),
  }
}

/** 缩略图地址：图片取 256 缩略图，视频取封面 */
export const thumb = (assetId: string) => assetUrls.variant(assetId, 'thumb-256')

/** 上传文件进资产存储，返回资产 id；kind 不对的文件跳过 */
export function uploadAll(
  files: File[],
  want: 'image' | 'video',
  options?: { capacity?: number; used?: string[] },
) {
  return uploadBatch(files, want, api.upload, options)
}

export function UploadFeedback({ value }: { value: UploadNotice | null }) {
  return value?.message ? (
    <span
      role={value.failed ? 'alert' : 'status'}
      className={`min-w-0 break-words text-xs ${value.failed ? 'text-danger' : 'text-ink-subtle'}`}
    >
      {value.message}
    </span>
  ) : null
}

/** 「从画布选」：列出当前画布上的图片 / 视频，单张槽位点一下就选中，多张槽位可以连续点 */
export function CanvasPick({
  media,
  type,
  multiple,
  taken,
  onPick,
  compact = false,
  label = '从画布选',
  disabled = false,
}: {
  media: CanvasMedia[]
  type: 'image' | 'video'
  multiple: boolean
  /** 已经用在条目里的资产，列表里标出来、不能重复选 */
  taken: string[]
  onPick(assetId: string): void
  compact?: boolean
  label?: string
  disabled?: boolean
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const grid = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<{ source: HTMLElement; index: number } | null>(null)
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    pendingFocus.current = null
    if (!pending || !multiple || !pending.source.matches(':disabled')) return
    const active = document.activeElement
    if (
      active !== document.body &&
      !grid.current?.contains(active) &&
      active !== grid.current?.closest('[role="dialog"]')
    )
      return
    const choices = [
      ...(grid.current?.querySelectorAll<HTMLButtonElement>('button[aria-pressed]') ?? []),
    ]
    const next = [...choices.slice(pending.index + 1), ...choices.slice(0, pending.index)].find(
      (button) => !button.disabled,
    )
    if (next) next.focus()
    else {
      setAnchor(null)
      anchor?.focus()
    }
  }, [taken, multiple, anchor])
  const list = media.filter((m) => m.kind === type)
  if (!media.length) return null
  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-expanded={!!anchor}
        disabled={disabled || !list.length}
        title={list.length ? undefined : `画布上没有${type === 'image' ? '图片' : '视频'}`}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        className={compact ? 'ui-btn ui-btn-quiet ui-btn-xs' : 'ui-drop-tile'}
      >
        <Icon name="board" size={compact ? 12 : 16} />
        从画布选
      </button>
      <Presence>
        {anchor && (
          <Popover
            anchor={anchor}
            onClose={() => setAnchor(null)}
            label="从画布选"
            width={344}
            placement="below"
          >
            <div className="ui-menu-label">
              画布上的{type === 'image' ? '图片' : '视频'}（{list.length}）
            </div>
            <div
              ref={grid}
              className="ui-scrollbar grid max-h-80 grid-cols-4 gap-2 overflow-y-auto p-2"
            >
              {list.map((m, index) => {
                const on = taken.includes(m.assetId)
                return (
                  <div
                    key={m.assetId}
                    className={`relative aspect-square overflow-hidden rounded-md bg-surface-2 ${
                      on ? 'opacity-40' : 'hover:ring-2 hover:ring-accent'
                    }`}
                  >
                    <LibraryThumbnail
                      src={
                        type === 'image' ? thumb(m.assetId) : assetUrls.variant(m.assetId, 'poster')
                      }
                      label={`选择${type === 'image' ? '图片' : '视频'}「${m.name || '未命名素材'}」`}
                      title={m.name || undefined}
                      selected={on}
                      disabled={disabled}
                      onSelect={() => {
                        const source = document.activeElement
                        if (source instanceof HTMLElement && grid.current?.contains(source))
                          pendingFocus.current = { source, index }
                        onPick(m.assetId)
                        if (!multiple) setAnchor(null)
                      }}
                    />
                  </div>
                )
              })}
            </div>
          </Popover>
        )}
      </Presence>
    </>
  )
}

export function SlotField({
  slot,
  images,
  used,
  media,
  onAdd,
  onRemove,
  disabled = false,
  onBusyChange,
  focusFallback,
  capacity = 24,
}: {
  slot: LibraryKindSpec['slots'][number]
  images: LibraryImage[]
  /** 整个条目已经用到的图片，「从画布选」里标出来 */
  used: string[]
  media: CanvasMedia[]
  onAdd(ids: string[]): void
  onRemove(assetId: string): void
  disabled?: boolean
  onBusyChange?(busy: boolean): void
  /** 满额时父级会撤下整个字段，先使用仍会保留的焦点落点。 */
  focusFallback?: RefObject<HTMLElement | null>
  capacity?: number
}) {
  const ref = useRef<HTMLInputElement>(null)
  const focus = useLibraryFieldFocus()
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<UploadNotice | null>(null)
  const room = Math.max(0, capacity - used.length)
  const pick = async (files: File[]) => {
    if (busy || disabled) return
    if (focus.props.ref.current?.contains(document.activeElement)) focus.park()
    setBusy(true)
    onBusyChange?.(true)
    setFeedback(null)
    try {
      const result = await uploadAll(files, 'image', {
        capacity: slot.multiple ? room : Math.min(1, room),
        used,
      })
      if (result.ids.length) {
        if (result.ids.length === room && document.activeElement === focus.props.ref.current)
          focusFallback?.current?.focus({ preventScroll: true })
        onAdd(result.ids)
      }
      setFeedback(result)
    } catch (err) {
      setFeedback({ message: (err as Error).message, failed: true })
    } finally {
      setBusy(false)
      onBusyChange?.(false)
    }
  }
  const canAdd = room > 0 && (slot.multiple || images.length === 0)
  return (
    <div
      {...focus.props}
      role="group"
      aria-label={slot.label}
      className="ui-field lib-focus-region"
    >
      {/* 标签和提示只占一行：提示折行会把这一格的上传框挤下去，跟同一行另一格对不齐 */}
      <span className="ui-label flex min-w-0 items-baseline" title={slot.hint}>
        <span className="flex-none">{slot.label}</span>
        {slot.hint && (
          <span className="ml-2 truncate font-normal text-ink-subtle">{slot.hint}</span>
        )}
      </span>
      <div className="flex flex-wrap gap-2">
        {images.map((img, index) => (
          <div
            key={img.assetId}
            className="group relative size-24 overflow-hidden rounded-lg bg-surface-2"
          >
            <LibraryThumbnail
              src={thumb(img.assetId)}
              label={`${slot.label} ${index + 1}`}
              disabled={busy || disabled}
            />
            <button
              type="button"
              aria-label="移除"
              title="移除"
              onClick={(event) => {
                if (document.activeElement === event.currentTarget) focus.park()
                onRemove(img.assetId)
              }}
              disabled={busy || disabled}
              className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn absolute top-1 right-1 bg-float opacity-0 group-hover:opacity-100 focus:opacity-100"
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
        {canAdd && (
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => ref.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              void pick([...e.dataTransfer.files])
            }}
            className="ui-drop-tile"
          >
            <Icon name={busy ? 'upload' : 'plus'} size={16} />
            {busy ? '上传中' : '上传'}
          </button>
        )}
        {canAdd && (
          <CanvasPick
            disabled={busy || disabled}
            media={media}
            type="image"
            multiple={!!slot.multiple}
            taken={used}
            onPick={(id) => {
              if (!slot.multiple || room === 1)
                (focusFallback?.current ?? focus.props.ref.current)?.focus({ preventScroll: true })
              setFeedback(null)
              onAdd([id])
            }}
          />
        )}
      </div>
      <UploadFeedback value={feedback} />
      <input
        ref={ref}
        type="file"
        accept="image/*"
        multiple={slot.multiple}
        hidden
        disabled={busy || disabled || !canAdd}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (files.length) void pick(files)
        }}
      />
    </div>
  )
}

export function VideoField({
  value,
  media,
  onChange,
  disabled = false,
  onBusyChange,
}: {
  value: string | null
  media: CanvasMedia[]
  onChange(v: string | null): void
  disabled?: boolean
  onBusyChange?(busy: boolean): void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const focus = useLibraryFieldFocus()
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<UploadNotice | null>(null)
  return (
    <div {...focus.props} role="group" aria-label="参考视频" className="ui-field lib-focus-region">
      <span className="ui-label">
        参考视频
        <span className="ml-2 font-normal text-ink-subtle">只给人看，不会送进模型</span>
      </span>
      {value ? (
        <div className="flex items-start gap-2">
          <ReferenceVideo src={assetUrls.original(value)} disabled={busy || disabled} />
          <button
            type="button"
            onClick={(event) => {
              if (document.activeElement === event.currentTarget) focus.park()
              onChange(null)
            }}
            disabled={busy || disabled}
            className="ui-btn ui-btn-quiet ui-btn-sm"
          >
            移除
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => ref.current?.click()}
            className="ui-drop-tile"
          >
            <Icon name="upload" size={16} />
            {busy ? '上传中' : '上传视频'}
          </button>
          <CanvasPick
            disabled={busy || disabled}
            media={media}
            type="video"
            multiple={false}
            taken={[]}
            onPick={(id) => {
              focus.park()
              setFeedback(null)
              onChange(id)
            }}
          />
        </div>
      )}
      <UploadFeedback value={feedback} />
      <input
        ref={ref}
        type="file"
        accept="video/*"
        hidden
        disabled={busy || disabled}
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (!files.length || busy || disabled) return
          setBusy(true)
          onBusyChange?.(true)
          setFeedback(null)
          try {
            const result = await uploadAll(files, 'video', { capacity: 1 })
            const [id] = result.ids
            if (id) onChange(id)
            setFeedback(result)
          } catch (err) {
            setFeedback({ message: (err as Error).message, failed: true })
          } finally {
            setBusy(false)
            onBusyChange?.(false)
          }
        }}
      />
    </div>
  )
}
