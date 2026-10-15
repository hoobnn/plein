import type { Engine } from '@plein/canvas-core'
import { defaultCols, elementMedia, groupShots, shotGroupOf } from '@plein/doc'
import { useState } from 'react'
import { assetUrls } from '../api/client'
import { useEngineVersion } from '../canvas/hooks'
import { arrangeShots, collageShots, reorderShot, unsetShotGroup } from '../canvas/shotGroup'
import { useCanvas } from '../stores/canvas'
import { Icon } from '../ui/icons'
import { Segmented } from '../ui/Segmented'

/** 列数选项最多给到 6 列 */
const MAX_COLS = 6

/**
 * 分镜组面板：按顺序列出组里的镜头（编号、缩略图、上下移），
 * 一键按顺序排版、拼成大图；从宫格切分来的还能回到原图。
 */
export function ShotGroupPanel({
  engine,
  frameId,
  onClose,
}: {
  engine: Engine
  frameId: string
  onClose(): void
}) {
  useEngineVersion(engine)
  const notify = useCanvas((s) => s.notify)
  const [numbers, setNumbers] = useState(true)
  const [busy, setBusy] = useState(false)
  const group = shotGroupOf(engine.doc.get(frameId))
  const shots = groupShots(engine.doc, frameId)
  if (!group) return null
  const n = shots.length
  const cols = Math.min(n, group.cols ?? defaultCols(n)) || 1
  const colOptions = Array.from({ length: Math.min(n, MAX_COLS) }, (_, i) => ({
    value: String(i + 1),
    label: `${i + 1} 列`,
  }))
  const source = group.source && engine.doc.get(group.source.elementId)

  const locate = (id: string) => {
    engine.selection.set([id])
    engine.flyTo([id])
  }
  const collage = async () => {
    setBusy(true)
    try {
      const made = await collageShots(engine, frameId, { numbers })
      notify(`拼好了：${made.width}×${made.height} 像素，放在分镜组右边`)
      engine.flyTo([made.id])
      onClose()
    } catch (err) {
      notify((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col">
      <div className="ui-menu-label flex items-center justify-between">
        <span>{`按顺序编号 · ${n} 张`}</span>
        {source && (
          <button
            type="button"
            className="text-xs font-normal text-accent hover:underline"
            title="回到切分之前的那张宫格图"
            onClick={() => locate(source.id)}
          >
            定位原图
          </button>
        )}
      </div>
      {n ? (
        <ol className="flex max-h-72 flex-col overflow-y-auto px-1" aria-label="镜头顺序">
          {shots.map((el, i) => {
            const m = elementMedia(el)
            return (
              <li
                key={el.id}
                className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-2"
              >
                <span className="w-5 text-right text-xs tabular-nums text-ink-subtle">{i + 1}</span>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title="在画布上定位"
                  onClick={() => locate(el.id)}
                >
                  {m && (
                    <img
                      src={assetUrls.variant(m.assetId, 'thumb-256')}
                      alt=""
                      className="size-9 shrink-0 rounded object-cover"
                      draggable={false}
                    />
                  )}
                  <span className="truncate text-sm">{el.name ?? `镜头 ${i + 1}`}</span>
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-quiet ui-icon-btn ui-btn-sm"
                  aria-label={`${el.name ?? `镜头 ${i + 1}`}上移`}
                  disabled={i === 0}
                  onClick={() => reorderShot(engine, frameId, el.id, i - 1)}
                >
                  <Icon name="arrowUp" size={14} />
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-quiet ui-icon-btn ui-btn-sm"
                  aria-label={`${el.name ?? `镜头 ${i + 1}`}下移`}
                  disabled={i === n - 1}
                  onClick={() => reorderShot(engine, frameId, el.id, i + 1)}
                >
                  <Icon name="arrowDown" size={14} />
                </button>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="px-3 py-2 text-sm text-ink-subtle">组里还没有图片，拖几张进来就会编号</p>
      )}
      <div className="ui-sep" />
      <div className="flex items-center gap-2 px-2 py-1.5">
        {colOptions.length > 1 && (
          <Segmented
            label="列数"
            options={colOptions}
            value={String(cols)}
            onChange={(v) => arrangeShots(engine, frameId, Number(v))}
          />
        )}
        <button
          type="button"
          className="ui-btn ui-btn-sm ml-auto"
          disabled={!n}
          title="按编号顺序排成网格，图片大小不变"
          onClick={() => arrangeShots(engine, frameId, cols)}
        >
          <Icon name="arrange" size={14} />
          按顺序排列
        </button>
      </div>
      <div className="flex items-center gap-2 px-2 pt-1 pb-2">
        <label className="ui-bar-check">
          <input type="checkbox" checked={numbers} onChange={(e) => setNumbers(e.target.checked)} />
          印序号
        </label>
        <button
          type="button"
          className="ui-btn ui-btn-primary ui-btn-sm ml-auto"
          disabled={n < 2 || busy}
          title={n < 2 ? '至少要两张图' : '按顺序拼成一张大图，原图不动'}
          onClick={() => void collage()}
        >
          <Icon name="collage" size={14} />
          {busy ? '拼图中…' : '拼成大图'}
        </button>
      </div>
      <div className="ui-sep" />
      <button
        type="button"
        className="ui-menu-item"
        onClick={() => {
          unsetShotGroup(engine, frameId)
          onClose()
        }}
      >
        <span className="ui-menu-text">
          <span>取消分镜组</span>
          <span className="ui-menu-desc">只去掉编号，图片都留着</span>
        </span>
      </button>
    </div>
  )
}
