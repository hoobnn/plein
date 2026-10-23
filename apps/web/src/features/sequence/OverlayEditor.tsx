import { SequenceOverlay } from '@plein/nodes'
import { useEffect, useState } from 'react'
import { Select } from '../../ui/Select'

export interface OverlayOption {
  value: string
  label: string
  duration?: number
}
export function OverlayEditor({
  overlays,
  sources,
  clips,
  selected,
  onSelect,
  onChange,
  onBoundary,
  duration,
  readOnly = false,
}: {
  overlays: SequenceOverlay[]
  sources: OverlayOption[]
  clips: OverlayOption[]
  selected?: string
  onSelect(id: string): void
  onChange(update: (latest: SequenceOverlay[]) => SequenceOverlay[]): void
  onBoundary(): void
  duration: number
  readOnly?: boolean
}) {
  const current = overlays.find((item) => item.id === selected) ?? overlays[0]
  const patch = (value: Partial<SequenceOverlay>) => {
    if (current)
      onChange((latest) =>
        latest.map((item) =>
          item.id === current.id ? SequenceOverlay.parse({ ...item, ...value }) : item,
        ),
      )
  }
  const move = (delta: number) => {
    if (!current) return
    onBoundary()
    onChange((latest) => {
      const next = [...latest],
        from = next.findIndex((item) => item.id === current.id),
        to = from + delta
      if (from < 0 || to < 0 || to >= next.length) return latest
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item!)
      return next
    })
    onBoundary()
  }
  return (
    <div
      className="flex flex-col gap-3"
      aria-label="叠加轨编辑"
      onFocusCapture={onBoundary}
      onBlurCapture={onBoundary}
      onClickCapture={(event) => {
        if ((event.target as Element).closest('button,input[type="checkbox"]')) onBoundary()
      }}
    >
      <p className="ui-help">
        把透明 WebM
        或视频连入「叠加」端口；叠加轨静音，后面的图层盖在前面。时间可绑定镜头，镜头重排时随它移动。
      </p>
      <button
        type="button"
        className="ui-btn ui-btn-secondary"
        disabled={!sources.length || duration <= 0}
        onClick={() => {
          const item = SequenceOverlay.parse({
            id: crypto.randomUUID(),
            source: sources[0]!.value,
            duration: Math.min(3, duration, sources[0]!.duration ?? 3),
          })
          onBoundary()
          onChange((latest) => [...latest, item])
          onSelect(item.id)
          onBoundary()
        }}
      >
        新增叠加
      </button>
      {!sources.length && (
        <p role="status" className="ui-help">
          先把视频连到序列的「叠加」端口。
        </p>
      )}
      {overlays.length > 0 && (
        <Select
          aria-label="选择叠加图层"
          value={current?.id ?? ''}
          options={overlays.map((item, index) => ({
            value: item.id,
            label: `${index + 1}. ${sources.find((source) => source.value === item.source)?.label ?? '来源已断开'}${item.hidden ? '（已隐藏）' : ''}`,
          }))}
          onChange={onSelect}
        />
      )}
      {current && (
        <>
          <div className="ui-field">
            <span className="ui-label">来源</span>
            <Select
              aria-label="叠加来源"
              value={current.source}
              options={
                sources.some((source) => source.value === current.source)
                  ? sources
                  : [...sources, { value: current.source, label: '来源已断开，请重新连接或替换' }]
              }
              onChange={(source) => patch({ source })}
            />
          </div>
          <div className="ui-field">
            <span className="ui-label">时间绑定</span>
            <Select
              aria-label="叠加时间绑定"
              value={current.clip ?? ''}
              options={[
                { value: '', label: '全片绝对时间' },
                ...clips,
                ...(current.clip && !clips.some((clip) => clip.value === current.clip)
                  ? [{ value: current.clip, label: '绑定镜头已断开' }]
                  : []),
              ]}
              onChange={(clip) => patch({ clip: clip || undefined })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { key: 'start', label: '起点（秒）', min: 0 },
                { key: 'duration', label: '时长（秒）', min: 1 / 30 },
                { key: 'in', label: '素材入点（秒）', min: 0 },
                { key: 'speed', label: '播放速度', min: 0.25, max: 4 },
                { key: 'x', label: 'X', min: 0, max: 1 },
                { key: 'y', label: 'Y', min: 0, max: 1 },
                { key: 'width', label: '宽度', min: 0.001, max: 1 },
                { key: 'height', label: '高度', min: 0.001, max: 1 },
                { key: 'opacity', label: '不透明度', min: 0, max: 1 },
              ] as const
            ).map((field) => (
              <NumberField
                key={`${current.id}:${field.key}`}
                label={`叠加${field.label}`}
                value={current[field.key]}
                readOnly={readOnly}
                min={field.min}
                max={'max' in field ? field.max : undefined}
                onChange={(value) => patch({ [field.key]: value })}
              />
            ))}
          </div>
          <p className="ui-help">
            X、Y、宽高和不透明度使用 0–1
            比例；右侧与底部超出画面时裁剪。锚定镜头时，时长截到该镜头末尾。
          </p>
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={!current.hidden}
              onChange={(event) => patch({ hidden: !event.target.checked })}
            />
            显示此叠加图层
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="ui-btn ui-btn-secondary"
              onClick={() => move(-1)}
              disabled={overlays[0]?.id === current.id}
            >
              下移一层
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-secondary"
              onClick={() => move(1)}
              disabled={overlays.at(-1)?.id === current.id}
            >
              上移一层
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-quiet"
              onClick={() => {
                onBoundary()
                onChange((latest) => latest.filter((item) => item.id !== current.id))
                onBoundary()
              }}
            >
              删除叠加
            </button>
          </div>
        </>
      )}
    </div>
  )
}
function NumberField({
  label,
  value,
  min,
  max,
  onChange,
  readOnly,
}: {
  label: string
  value: number
  min: number
  max?: number
  onChange(value: number): void
  readOnly: boolean
}) {
  const [draft, setDraft] = useState<string | null>(null)
  useEffect(() => {
    if (readOnly) setDraft(null)
  }, [readOnly])
  const n = Number(draft)
  const invalid =
    draft !== null &&
    (!draft.trim() || !Number.isFinite(n) || n < min || (max !== undefined && n > max))
  return (
    <label className="ui-field">
      <span className="ui-label">{label}</span>
      <input
        type="number"
        className="ui-input"
        aria-label={label}
        aria-invalid={invalid || undefined}
        min={min}
        max={max}
        step={0.01}
        value={draft ?? value}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (!readOnly && draft !== null && !invalid) onChange(n)
          setDraft(null)
        }}
        onKeyDown={(event) => {
          if (!event.nativeEvent.isComposing && event.key === 'Enter') event.currentTarget.blur()
        }}
      />
    </label>
  )
}
