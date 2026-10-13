import type { LibraryKindSpec } from '@plein/nodes'
import type { LibraryImage } from '@plein/protocol'
import { useRef, useState } from 'react'
import { api, assetUrls } from '../api/client'
import type { CanvasMedia } from '../canvas/library'
import { Icon } from '../ui/icons'
import { Popover } from '../ui/Popover'
import { Presence } from '../ui/Presence'

/** 资产库编辑页的图片字段：上传、从画布选、槽位与参考视频 */

/** 缩略图地址：图片取 256 缩略图，视频取封面 */
export const thumb = (assetId: string) => assetUrls.variant(assetId, 'thumb-256')

/** 上传文件进资产存储，返回资产 id；kind 不对的文件跳过 */
export async function uploadAll(files: File[], want: 'image' | 'video') {
  const out: string[] = []
  for (const f of files) {
    if (!f.type.startsWith(`${want}/`)) continue
    const a = await api.upload(f)
    out.push(a.id)
  }
  return out
}

/** 「从画布选」：列出当前画布上的图片 / 视频，单张槽位点一下就选中，多张槽位可以连续点 */
export function CanvasPick({
  media,
  type,
  multiple,
  taken,
  onPick,
}: {
  media: CanvasMedia[]
  type: 'image' | 'video'
  multiple: boolean
  /** 已经用在条目里的资产，列表里标出来、不能重复选 */
  taken: string[]
  onPick(assetId: string): void
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const list = media.filter((m) => m.kind === type)
  if (!media.length) return null
  return (
    <>
      <button
        type="button"
        aria-expanded={!!anchor}
        disabled={!list.length}
        title={list.length ? undefined : `画布上没有${type === 'image' ? '图片' : '视频'}`}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        className="ui-drop-tile"
      >
        <Icon name="board" size={16} />
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
            <div className="ui-scrollbar grid max-h-80 grid-cols-4 gap-2 overflow-y-auto p-2">
              {list.map((m) => {
                const on = taken.includes(m.assetId)
                return (
                  <button
                    key={m.assetId}
                    type="button"
                    title={m.name || undefined}
                    aria-pressed={on}
                    disabled={on}
                    onClick={() => {
                      onPick(m.assetId)
                      if (!multiple) setAnchor(null)
                    }}
                    className={`relative aspect-square overflow-hidden rounded-md bg-surface-2 ${
                      on ? 'opacity-40' : 'hover:ring-2 hover:ring-accent'
                    }`}
                  >
                    <img
                      src={
                        type === 'image' ? thumb(m.assetId) : assetUrls.variant(m.assetId, 'poster')
                      }
                      alt=""
                      loading="lazy"
                      draggable={false}
                      className="size-full object-cover"
                    />
                    {on && (
                      <span className="absolute inset-0 flex items-center justify-center text-ink">
                        <Icon name="check" size={16} />
                      </span>
                    )}
                  </button>
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
}: {
  slot: LibraryKindSpec['slots'][number]
  images: LibraryImage[]
  /** 整个条目已经用到的图片，「从画布选」里标出来 */
  used: string[]
  media: CanvasMedia[]
  onAdd(ids: string[]): void
  onRemove(assetId: string): void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pick = async (files: File[]) => {
    setBusy(true)
    setError(null)
    try {
      const ids = await uploadAll(files, 'image')
      if (ids.length) onAdd(slot.multiple ? ids : ids.slice(0, 1))
      else setError('只能放图片')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const canAdd = slot.multiple || images.length === 0
  return (
    <div className="ui-field">
      {/* 标签和提示只占一行：提示折行会把这一格的上传框挤下去，跟同一行另一格对不齐 */}
      <span className="ui-label flex min-w-0 items-baseline" title={slot.hint}>
        <span className="flex-none">{slot.label}</span>
        {slot.hint && (
          <span className="ml-2 truncate font-normal text-ink-subtle">{slot.hint}</span>
        )}
      </span>
      <div className="flex flex-wrap gap-2">
        {images.map((img) => (
          <div
            key={img.assetId}
            className="group relative size-24 overflow-hidden rounded-lg bg-surface-2"
          >
            <img
              src={thumb(img.assetId)}
              alt=""
              draggable={false}
              className="size-full object-cover"
            />
            <button
              type="button"
              aria-label="移除"
              title="移除"
              onClick={() => onRemove(img.assetId)}
              className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn absolute top-1 right-1 bg-float opacity-0 group-hover:opacity-100 focus:opacity-100"
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
        {canAdd && (
          <button
            type="button"
            disabled={busy}
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
            media={media}
            type="image"
            multiple={!!slot.multiple}
            taken={used}
            onPick={(id) => onAdd([id])}
          />
        )}
      </div>
      {error && <span className="text-xs text-danger">{error}</span>}
      <input
        ref={ref}
        type="file"
        accept="image/*"
        multiple={slot.multiple}
        hidden
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
}: {
  value: string | null
  media: CanvasMedia[]
  onChange(v: string | null): void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="ui-field">
      <span className="ui-label">
        参考视频
        <span className="ml-2 font-normal text-ink-subtle">只给人看，不会送进模型</span>
      </span>
      {value ? (
        <div className="flex items-start gap-2">
          {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- 参考视频没有字幕 */}
          <video
            src={assetUrls.original(value)}
            controls
            className="max-h-56 w-full rounded-lg bg-black"
          />
          <button
            type="button"
            onClick={() => onChange(null)}
            className="ui-btn ui-btn-quiet ui-btn-sm"
          >
            移除
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => ref.current?.click()}
            className="ui-drop-tile"
          >
            <Icon name="upload" size={16} />
            {busy ? '上传中' : '上传视频'}
          </button>
          <CanvasPick media={media} type="video" multiple={false} taken={[]} onPick={onChange} />
        </div>
      )}
      {error && <span className="text-xs text-danger">{error}</span>}
      <input
        ref={ref}
        type="file"
        accept="video/*"
        hidden
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (!files.length) return
          setBusy(true)
          setError(null)
          try {
            const [id] = await uploadAll(files, 'video')
            if (id) onChange(id)
            else setError('只能放视频')
          } catch (err) {
            setError((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      />
    </div>
  )
}
