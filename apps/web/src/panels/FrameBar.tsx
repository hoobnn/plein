import type { Engine } from '@plein/canvas-core'
import { useState } from 'react'
import { groupNodes, runGroup, templateData } from '../canvas/groups'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { useTemplates } from '../stores/templates'
import { useEngineVersion } from './Generator'

/** 选中单个 Frame 时浮在它右上角：运行整组、存为模板 */
export function FrameBar({ remote }: { remote: boolean }) {
  const engine = useCanvas((s) => s.engine)
  if (!engine || !remote) return null
  return <FrameBarHost engine={engine} />
}

function FrameBarHost({ engine }: { engine: Engine }) {
  useEngineVersion(engine)
  const catalog = useCatalog((s) => s.catalog)
  const notify = useCanvas((s) => s.notify)
  const [video, setVideo] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const ids = engine.selection.values()
  const el = ids.length === 1 ? engine.scene.get(ids[0]!) : undefined
  const rect = el?.kind === 'frame' ? engine.scene.rect(el.id) : undefined
  if (!el || !rect || engine.doc.readOnly) return null

  const count = groupNodes(engine, el.id, catalog, video).length
  const tr = engine.worldToClient(rect.x + rect.w, rect.y)
  const name = el.name ?? 'Frame'

  const run = async () => {
    setBusy(el.id)
    const r = await runGroup(engine, el.id, catalog, { video })
    setBusy(null)
    const parts = [`「${name}」运行完成：${r.succeeded} 个成功`]
    if (r.failed) parts.push(`${r.failed} 个失败`)
    if (r.skipped) parts.push(`${r.skipped} 个因上游失败跳过`)
    notify(parts.join('，'))
  }
  const save = async () => {
    const title = prompt('模板名称', name)?.trim()
    if (!title) return
    try {
      await useTemplates.getState().save(title, templateData(engine, el.id))
      notify(`已存为模板「${title}」，双击空白处在“我的模板”里找到`)
    } catch (err) {
      notify((err as Error).message)
    }
  }

  const btn =
    'h-7 rounded-md px-2 text-xs text-ink hover:bg-white/8 disabled:cursor-not-allowed disabled:opacity-40'
  return (
    <div
      role="toolbar"
      aria-label="Frame 操作"
      // 贴在 Frame 右上角外侧；Frame 顶到页头时不压住页头
      style={{ right: window.innerWidth - tr.x, top: Math.max(64, tr.y - 36) }}
      className="pointer-events-auto fixed z-20 flex items-center gap-1 rounded-lg bg-surface/95 p-0.5 shadow-[var(--shadow-2)] backdrop-blur-xl"
    >
      <label className="flex h-7 items-center gap-1 px-1.5 text-xs text-ink-muted">
        <input type="checkbox" checked={video} onChange={(e) => setVideo(e.target.checked)} />
        含视频
      </label>
      <button
        type="button"
        className={btn}
        disabled={!count || busy === el.id}
        title={count ? undefined : '组内没有要生成的节点'}
        onClick={() => void run()}
      >
        {busy === el.id ? '运行中…' : `运行整组${count ? `（${count}）` : ''}`}
      </button>
      <button type="button" className={btn} onClick={() => void save()}>
        存为模板
      </button>
    </div>
  )
}
