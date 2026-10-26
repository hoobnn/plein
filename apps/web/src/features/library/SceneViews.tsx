import { type SceneView, sceneViewProblem, renamed } from '@plein/nodes'
import { useRef, useState } from 'react'
import type { CanvasMedia } from './canvas'
import { SlotField } from './LibraryFields'

/** 场景视角与基础图片分开保存，指定视角不会偷偷补入主图。 */
export function SceneViews({
  value,
  onChange,
  media,
  disabled,
  onBusyChange,
}: {
  value: SceneView[]
  onChange(views: SceneView[]): void
  media: CanvasMedia[]
  disabled: boolean
  onBusyChange(busy: boolean): void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const current = value.find((v) => v.id === selected)
  const patch = (update: Partial<SceneView>) => {
    if (current) onChange(value.map((v) => (v.id === current.id ? { ...v, ...update } : v)))
  }
  const add = () => {
    let name = '新视角',
      n = 1
    while (sceneViewProblem(value, name)) name = `新视角${++n}`
    const next: SceneView = {
      id: crypto.randomUUID(),
      name,
      aliases: [],
      description: '',
      images: [],
    }
    onChange([...value, next])
    setSelected(next.id)
  }
  return (
    <div ref={panel} role="group" aria-label="场景视角档案" className="ui-field">
      <h3 className="ui-section-title">场景视角</h3>
      <p className="ui-help">
        为同一地点保存不同机位。生成时输入
        @场景名/视角名，使用该视角的描述和参考图；不附加基础场景图。
      </p>
      <div className="flex flex-wrap gap-2">
        {value.map((v) => (
          <button
            key={v.id}
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm"
            aria-pressed={selected === v.id}
            disabled={disabled}
            onClick={() => setSelected(v.id)}
          >
            {v.name} · {v.images.length} 图
          </button>
        ))}
        <button
          type="button"
          disabled={disabled || value.length >= 24}
          className="ui-btn ui-btn-secondary ui-btn-sm"
          onClick={add}
        >
          添加视角
        </button>
      </div>
      {current && (
        <div className="flex flex-col gap-3 rounded-lg border border-line p-3">
          <ViewName
            key={current.id}
            view={current}
            views={value}
            disabled={disabled}
            onChange={(name) => patch(renamed(current, name))}
          />
          <label className="ui-field">
            <span className="ui-label">视角描述</span>
            <textarea
              aria-label="视角描述"
              className="ui-input"
              value={current.description}
              disabled={disabled}
              maxLength={1000}
              placeholder="如：从教室门口看向黑板，窗户在画面左侧"
              onChange={(e) => patch({ description: e.target.value })}
            />
          </label>
          <SlotField
            slot={{
              id: 'view',
              label: '视角参考图',
              multiple: true,
              hint: '最多 4 张；可从当前画布选取生成结果',
            }}
            images={current.images.map((assetId) => ({ slot: 'view', assetId }))}
            used={current.images}
            media={media}
            disabled={disabled}
            onBusyChange={onBusyChange}
            onAdd={(ids) =>
              patch({ images: [...new Set([...current.images, ...ids])].slice(0, 4) })
            }
            onRemove={(id) => patch({ images: current.images.filter((x) => x !== id) })}
            capacity={4}
          />
          <button
            type="button"
            disabled={disabled}
            className="ui-btn ui-btn-quiet ui-btn-sm self-start text-danger"
            onClick={() => {
              onChange(value.filter((v) => v.id !== current.id))
              setSelected(null)
            }}
          >
            删除视角
          </button>
          <p className="ui-help">
            删除后，已有的该视角引用需要重新选择；已有生成结果保留。改名会保留旧名供原提示词继续引用。
          </p>
        </div>
      )}
    </div>
  )
}

function ViewName({
  view,
  views,
  disabled,
  onChange,
}: {
  view: SceneView
  views: SceneView[]
  disabled: boolean
  onChange(name: string): void
}) {
  const [draft, setDraft] = useState(view.name)
  const problem = sceneViewProblem(views, draft, view.id)
  return (
    <label className="ui-field">
      <span className="ui-label">视角名称</span>
      <input
        aria-label="视角名称"
        className="ui-input"
        value={draft}
        disabled={disabled}
        aria-invalid={!!problem}
        maxLength={20}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (!problem) onChange(draft.trim())
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (!problem) {
              onChange(draft.trim())
              e.currentTarget.blur()
            }
          }
        }}
      />
      {problem && (
        <span role="alert" className="text-xs text-danger">
          {problem}
        </span>
      )}
    </label>
  )
}
