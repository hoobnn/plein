import type { Engine } from '@plein/canvas-core'
import { updateElement } from '@plein/doc'
import { useState } from 'react'
import { groupNodes, templateData } from '../canvas/groups'
import { useEngineVersion } from '../canvas/hooks'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { useGroupRuns } from '../stores/groupRuns'
import { useTemplates } from '../stores/templates'
import { Icon } from '../ui/icons'
import { promptDialog } from '../ui/Dialog'
import { withShortcut } from '../ui/keys'
import { Popover } from '../ui/Popover'
import { Presence } from '../ui/Presence'
import { cancelGroup, runFrame } from './run'

/** 页头占的高度：Frame 顶到页头时工具条不压住它 */
const TOP_RESERVED = 64

/** Frame 预设色：写进元素的 color，GPU 渲染据此画底色和边框 */
const COLORS: Array<{ label: string; value: string | undefined }> = [
  { label: '默认', value: undefined },
  { label: '红', value: '#f87171' },
  { label: '橙', value: '#fb923c' },
  { label: '黄', value: '#facc15' },
  { label: '绿', value: '#4ade80' },
  { label: '青', value: '#22d3ee' },
  { label: '蓝', value: '#60a5fa' },
  { label: '紫', value: '#a78bfa' },
  { label: '粉', value: '#f472b6' },
]

/** 选中单个 Frame 时浮在它右上角：颜色、解组；远端画布还有运行整组、存为模板 */
export function FrameBar({ remote }: { remote: boolean }) {
  const engine = useCanvas((s) => s.engine)
  if (!engine) return null
  return <FrameBarHost engine={engine} remote={remote} />
}

function FrameBarHost({ engine, remote }: { engine: Engine; remote: boolean }) {
  useEngineVersion(engine)
  const catalog = useCatalog((s) => s.catalog)
  const notify = useCanvas((s) => s.notify)
  const [video, setVideo] = useState(false)
  const [force, setForce] = useState(false)
  const runs = useGroupRuns((s) => s.runs)
  const [palette, setPalette] = useState<HTMLElement | null>(null)
  const ids = engine.selection.values()
  const el = ids.length === 1 ? engine.scene.get(ids[0]!) : undefined
  const rect = el?.kind === 'frame' ? engine.scene.rect(el.id) : undefined
  if (!el || !rect || engine.doc.readOnly) return null

  const count = groupNodes(engine, el.id, catalog, video).length
  const tr = engine.worldToClient(rect.x + rect.w, rect.y)
  const name = el.name ?? 'Frame'
  const busy = el.id in runs
  const group = runs[el.id] ?? null
  const save = async () => {
    const title = await promptDialog({
      title: '存为模板',
      message: '存好后，双击画布空白处，在「我的模板」里找到它。',
      defaultValue: name,
      placeholder: '模板名称',
      confirmLabel: '保存',
    })
    if (!title) return
    try {
      await useTemplates.getState().save(title, templateData(engine, el.id))
      notify(`已存为模板「${title}」，双击空白处在“我的模板”里找到`)
    } catch (err) {
      notify((err as Error).message)
    }
  }

  const btn = 'ui-bar-btn'
  return (
    <div
      role="toolbar"
      aria-label="Frame 操作"
      // 贴在 Frame 右上角外侧，离 Frame 8；Frame 顶到页头时不压住页头
      style={{ right: window.innerWidth - tr.x, top: Math.max(TOP_RESERVED, tr.y - 48) }}
      className="ui-bar ui-bar-sm pointer-events-auto fixed z-20"
    >
      <button
        type="button"
        className={btn}
        aria-expanded={!!palette}
        onClick={(e) => setPalette(palette ? null : e.currentTarget)}
      >
        <span
          className="size-3 rounded-full border border-line"
          style={{ background: el.color ?? 'transparent' }}
          aria-hidden="true"
        />
        颜色
      </button>
      <button
        type="button"
        className={btn}
        title={`${withShortcut('解组', 'mod+shift+g')}：保留里面的元素，去掉 Frame`}
        onClick={() => engine.ungroupSelection()}
      >
        <Icon name="ungroup" size={14} />
        解组
      </button>
      {remote && <div className="ui-bar-sep" />}
      {remote && (
        <>
          <label className="flex h-8 cursor-pointer items-center gap-2 px-2.5 text-xs text-ink-muted hover:text-ink">
            <input type="checkbox" checked={video} onChange={(e) => setVideo(e.target.checked)} />
            含视频
          </label>
          <label
            className="flex h-8 cursor-pointer items-center gap-2 px-2.5 text-xs text-ink-muted hover:text-ink"
            title="默认参数和输入都没变的节点沿用原结果；勾选后全部重新生成"
          >
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            全部重跑
          </label>
          {busy ? (
            <button
              type="button"
              className={btn}
              disabled={!group}
              title="停止整组：正在跑和排队的节点一起取消"
              onClick={() => group && void cancelGroup(group)}
            >
              <Icon name="stop" size={12} />
              停止运行
            </button>
          ) : (
            <button
              type="button"
              className={btn}
              disabled={!count}
              title={count ? undefined : '组内没有要生成的节点'}
              onClick={() => void runFrame(el.id, name, { video, force })}
            >
              <Icon name="play" size={12} />
              {`运行整组${count ? `（${count}）` : ''}`}
            </button>
          )}
          <button type="button" className={btn} onClick={() => void save()}>
            <Icon name="layers" size={14} />
            存为模板
          </button>
        </>
      )}
      <Presence>
        {palette && (
          <Popover anchor={palette} onClose={() => setPalette(null)} label="Frame 颜色" width={196}>
            <div className="grid grid-cols-5 gap-1.5 p-2">
              {COLORS.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  title={c.label}
                  aria-label={c.label}
                  aria-pressed={el.color === c.value}
                  onClick={() => {
                    updateElement(engine.doc, el.id, { color: c.value })
                    setPalette(null)
                  }}
                  className="flex size-7 items-center justify-center rounded-full border border-line text-ink-subtle transition-transform hover:scale-110 aria-pressed:ring-2 aria-pressed:ring-accent aria-pressed:ring-offset-2 aria-pressed:ring-offset-menu"
                  style={{ background: c.value ?? 'transparent' }}
                >
                  {!c.value && <Icon name="x" size={12} />}
                </button>
              ))}
            </div>
          </Popover>
        )}
      </Presence>
    </div>
  )
}
