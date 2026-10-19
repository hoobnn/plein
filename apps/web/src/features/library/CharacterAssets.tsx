import { CHARACTER_IMAGE_SLOTS, type LibrarySlot } from '@plein/nodes'
import type { LibraryImage } from '@plein/protocol'
import { useLayoutEffect, useRef, useState } from 'react'
import { assetUrls } from '../../api/client'
import { Icon, type IconName } from '../../ui/icons'
import { Select } from '../../ui/Select'
import type { CanvasMedia } from './canvas'
import {
  CanvasPick,
  SlotField,
  thumb,
  uploadAll,
  UploadFeedback,
  useLibraryFieldFocus,
} from './LibraryFields'
import type { UploadNotice } from './uploadBatch'
import { LibraryThumbnail } from './LibraryMedia'

type ChangeImages = (update: (images: LibraryImage[]) => LibraryImage[]) => void

const VISUAL_ORDER = ['portrait', 'full_body', 'face_grid', 'character_3view']
const SLOT_ICONS: Record<string, IconName> = {
  portrait: 'character',
  full_body: 'outfit',
  face_grid: 'expression',
  character_3view: 'gridSplit',
}

/** 四类形象放在一起审看；原始素材和尚未分类的参考保留在下方。 */
export function CharacterAssets({
  images,
  media,
  selected,
  onSelect,
  onChange,
  busy,
  onBusyChange,
}: {
  images: LibraryImage[]
  media: CanvasMedia[]
  selected: string | null
  onSelect(assetId: string | null, caption?: string): void
  onChange: ChangeImages
  busy: boolean
  onBusyChange(busy: boolean): void
}) {
  const slots = VISUAL_ORDER.map((id) => CHARACTER_IMAGE_SLOTS.find((s) => s.id === id)!)
  const extras = images.filter((image) => !slots.some((s) => s.id === image.slot))
  const focus = useLibraryFieldFocus()
  const summary = useRef<HTMLElement>(null)
  const nextFocus = useRef<string | null>(null)
  const parkFor = (label: string) => {
    focus.park()
    nextFocus.current = label
  }
  useLayoutEffect(() => {
    const label = nextFocus.current
    nextFocus.current = null
    if (!label || document.activeElement !== focus.props.ref.current) return
    const target =
      label === 'summary'
        ? summary.current
        : focus.props.ref.current?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
  const count = slots.filter((s) => images.some((image) => image.slot === s.id)).length
  const [error, setError] = useState<string | null>(null)
  const used = images.map((image) => image.assetId)
  const change: ChangeImages = (update) =>
    onChange((current) => {
      const next = update(current)
      return next.length <= 24 ? next : current
    })
  const occurrences = new Map<string, number>()
  const extraEntries = extras.map((image) => {
    const key = `${image.slot}:${image.assetId}`
    const occurrence = occurrences.get(key) ?? 0
    occurrences.set(key, occurrence + 1)
    return { image, key: `${key}:${occurrence}` }
  })
  const assign = (slot: string, assetId: string) => {
    change((current) => [...current.filter((image) => image.slot !== slot), { slot, assetId }])
    onSelect(assetId, slots.find((s) => s.id === slot)?.label)
  }
  return (
    <div
      {...focus.props}
      role="group"
      aria-label="角色形象"
      className="lib-focus-region flex flex-col gap-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">角色形象</h3>
          <p className="mt-1 text-xs text-ink-subtle">四类图片共同记录这个人的长相、造型与表情。</p>
        </div>
        <span className="ui-chip shrink-0 tabular-nums">{count} / 4 已添加</span>
      </div>
      <div className="lib-character-assets" aria-label="四类角色图片">
        {slots.map((slot) => (
          <CharacterAssetTile
            key={slot.id}
            slot={slot}
            assetId={images.find((image) => image.slot === slot.id)?.assetId ?? null}
            media={media}
            selected={selected}
            used={used}
            disabled={
              busy || (images.length >= 24 && !images.some((image) => image.slot === slot.id))
            }
            onBusyChange={onBusyChange}
            onSelect={onSelect}
            onAdd={(assetId) => assign(slot.id, assetId)}
            onRemove={() => {
              change((current) => current.filter((image) => image.slot !== slot.id))
              onSelect(null)
            }}
          />
        ))}
      </div>
      <details className="lib-character-extras" open={extras.length > 0 || undefined}>
        <summary ref={summary}>
          <span>其他参考</span>
          <span className="text-xs text-ink-subtle">{extras.length} 张</span>
          <Icon name="chevronDown" size={14} />
        </summary>
        <p className="text-xs text-ink-subtle">
          补充素材也会随角色保存；可以将已有图片归入上面的四类。
        </p>
        {extras.length > 0 && (
          <ul className="lib-character-extra-list">
            {extraEntries.map(({ image, key }, index) => (
              <li key={key}>
                <div className="lib-character-extra-preview">
                  <LibraryThumbnail
                    src={thumb(image.assetId)}
                    label={`预览其他参考 ${index + 1}`}
                    contain
                    onSelect={() => onSelect(image.assetId, '其他参考')}
                  />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <fieldset disabled={busy}>
                    <Select
                      aria-label={`参考图 ${index + 1} 的分类`}
                      value="extra"
                      restoreFocusOnSelect={false}
                      options={[
                        { value: 'extra', label: '其他参考' },
                        ...slots.map((slot) => ({ value: slot.id, label: slot.label })),
                      ]}
                      onChange={(slot) => {
                        if (slot === 'extra') return
                        const label = slots.find((s) => s.id === slot)?.label
                        if (label) parkFor(`预览${label}`)
                        change((current) => {
                          const extraIndex = current.indexOf(image)
                          return current.map((entry, i) =>
                            i === extraIndex
                              ? { ...entry, slot }
                              : entry.slot === slot
                                ? { ...entry, slot: 'extra' }
                                : entry,
                          )
                        })
                        onSelect(image.assetId, slots.find((s) => s.id === slot)?.label)
                      }}
                    />
                  </fieldset>
                  {image.slot !== 'extra' && (
                    <span className="text-xs text-ink-subtle">原分类：{image.slot}</span>
                  )}
                </div>
                <button
                  type="button"
                  aria-label={`移除其他参考 ${index + 1}`}
                  disabled={busy}
                  onClick={(event) => {
                    if (document.activeElement === event.currentTarget)
                      parkFor(
                        extras.length === 1
                          ? 'summary'
                          : `预览其他参考 ${Math.min(index + 1, extras.length - 1)}`,
                      )
                    change((current) => current.filter((entry) => entry !== image))
                    if (selected === image.assetId) onSelect(null)
                  }}
                  className="ui-btn ui-btn-quiet ui-icon-btn"
                >
                  <Icon name="x" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <SlotField
          slot={{
            id: 'extra',
            label: images.length < 24 ? '添加补充参考' : '补充参考',
            multiple: true,
          }}
          images={[]}
          used={used}
          media={media}
          disabled={busy}
          onBusyChange={onBusyChange}
          focusFallback={focus.props.ref}
          onAdd={(ids) => {
            if (images.length + ids.length > 24) {
              setError('每个角色最多保存 24 张基础参考图，请减少本次添加的图片。')
              return
            }
            setError(null)
            if (
              images.length + ids.length === 24 &&
              document.activeElement === focus.props.ref.current
            )
              nextFocus.current = `预览其他参考 ${extras.length + ids.length}`
            change((current) => [...current, ...ids.map((assetId) => ({ slot: 'extra', assetId }))])
          }}
          onRemove={() => {}}
        />
        {images.length >= 24 && <p className="text-xs text-ink-subtle">已达到 24 张参考图上限。</p>}
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </details>
    </div>
  )
}

function CharacterAssetTile({
  slot,
  assetId,
  media,
  selected,
  used,
  onSelect,
  onAdd,
  onRemove,
  disabled,
  onBusyChange,
}: {
  slot: LibrarySlot
  assetId: string | null
  media: CanvasMedia[]
  selected: string | null
  used: string[]
  onSelect(assetId: string | null, caption?: string): void
  onAdd(assetId: string): void
  onRemove(): void
  disabled: boolean
  onBusyChange(busy: boolean): void
}) {
  const input = useRef<HTMLInputElement>(null)
  const preview = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<UploadNotice | null>(null)
  const [imageRevision, setImageRevision] = useState(0)
  const [failedImage, setFailedImage] = useState<string | null>(null)
  const imageKey = `${assetId}:${imageRevision}`
  const currentImage = useRef(imageKey)
  currentImage.current = imageKey
  const selectImage = (id: string) => {
    setFeedback(null)
    // 内容寻址的同图上传仍返回同一 id；明确选择也应重新尝试图片加载。
    setImageRevision((revision) => revision + 1)
    onAdd(id)
  }
  const upload = async (files: File[]) => {
    if (busy || disabled) return
    setBusy(true)
    onBusyChange(true)
    setFeedback(null)
    try {
      const result = await uploadAll(files, 'image', { capacity: 1 })
      const [id] = result.ids
      if (id) selectImage(id)
      setFeedback(result)
    } catch (err) {
      setFeedback({ message: (err as Error).message, failed: true })
    } finally {
      setBusy(false)
      onBusyChange(false)
    }
  }
  return (
    <section
      className="lib-character-tile"
      data-character-slot={slot.id}
      data-selected={!!assetId && selected === assetId ? '' : undefined}
      aria-label={slot.label}
    >
      <button
        ref={preview}
        type="button"
        aria-label={assetId ? `预览${slot.label}` : `添加${slot.label}`}
        aria-pressed={!!assetId && selected === assetId}
        disabled={busy || disabled}
        title={slot.hint}
        onClick={() => (assetId ? onSelect(assetId, slot.label) : input.current?.click())}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          void upload([...e.dataTransfer.files])
        }}
        className="lib-character-tile-preview lib-focus-region"
      >
        {assetId ? (
          failedImage === imageKey ? (
            <span className="lib-character-tile-empty">
              <Icon name="image" size={24} />
              <span>图片加载失败</span>
            </span>
          ) : (
            <img
              key={imageKey}
              src={assetUrls.variant(assetId, 'thumb-1024')}
              alt={slot.label}
              draggable={false}
              onError={() => {
                if (currentImage.current === imageKey) setFailedImage(imageKey)
              }}
            />
          )
        ) : (
          <span className="lib-character-tile-empty">
            <Icon name={SLOT_ICONS[slot.id] ?? 'image'} size={24} />
            <span>{busy ? '上传中…' : '添加图片'}</span>
          </span>
        )}
        {assetId && (
          <span className="lib-character-tile-check">
            <Icon name="check" size={12} />
          </span>
        )}
      </button>
      <div className="lib-character-tile-info">
        <h4>{slot.label}</h4>
        <p>{slot.hint}</p>
        <div className="lib-character-tile-actions">
          {failedImage === imageKey && (
            <button
              type="button"
              disabled={busy || disabled}
              aria-label={`重新加载${slot.label}`}
              className="ui-btn ui-btn-quiet ui-btn-xs"
              onClick={(event) => {
                if (document.activeElement === event.currentTarget) preview.current?.focus()
                setImageRevision((revision) => revision + 1)
              }}
            >
              <Icon name="retry" size={12} />
              重新加载
            </button>
          )}
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => input.current?.click()}
            className="ui-btn ui-btn-quiet ui-btn-xs"
          >
            <Icon name="upload" size={12} />
            {busy ? '上传中' : assetId ? '替换' : '上传'}
          </button>
          <CanvasPick
            disabled={busy || disabled}
            compact
            label={`从画布选择${slot.label}`}
            media={media}
            type="image"
            multiple={false}
            taken={used.filter((id) => id !== assetId)}
            onPick={selectImage}
          />
          {assetId && (
            <button
              type="button"
              disabled={busy || disabled}
              onClick={onRemove}
              className="ui-btn ui-btn-quiet ui-btn-xs text-ink-subtle"
            >
              移除
            </button>
          )}
        </div>
        <UploadFeedback value={feedback} />
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        aria-label={`上传${slot.label}`}
        disabled={busy || disabled}
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (files.length) void upload(files)
        }}
      />
    </section>
  )
}
