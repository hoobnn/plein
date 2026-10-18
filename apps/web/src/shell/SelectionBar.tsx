import { type Engine, union } from '@plein/canvas-core'
import { elementMedia } from '@plein/doc'
import { downloadAll } from '../canvas/grid'
import { mediaIn } from '../features/library/canvas'
import { useEngineVersion, useFollow } from '../canvas/hooks'
import { fitCanvasToolbar } from '../canvas/floatingPanel'
import { LibraryAdd } from '../features/library/LibraryAdd'
import { type MediaTarget, MediaBatchTools } from './MediaTools'
import { useAgent } from '../features/agent/store'
import { useCanvas } from '../stores/canvas'
import { Icon } from '../ui/icons'
import { withShortcut } from '../ui/keys'
import { saveAsTemplate } from '../features/templates/actions'

/** 节点标题在卡片外上方，工具条要让开它 */
const TITLE_H = 30

/** 选中 2 个及以上元素时浮在选区上方 */
export function SelectionBar({ remote }: { remote: boolean }) {
  const engine = useCanvas((s) => s.engine)
  if (!engine) return null
  return <SelectionBarHost engine={engine} remote={remote} />
}

function SelectionBarHost({ engine, remote }: { engine: Engine; remote: boolean }) {
  useEngineVersion(engine)
  const notify = useCanvas((s) => s.notify)
  const ids = engine.selection.values()
  const place = (): { top: number; right: number; maxWidth: number } | null => {
    const box = union(ids.map((id) => engine.scene.rect(id)).filter((r) => !!r))
    if (!box) return null
    const tl = engine.worldToClient(box.x, box.y)
    const tr = engine.worldToClient(box.x + box.w, box.y)
    return fitCanvasToolbar(
      { x: (tl.x + tr.x) / 2, y: tl.y - TITLE_H },
      {
        width: ref.current?.offsetWidth ?? window.innerWidth,
        height: ref.current?.offsetHeight ?? 40,
      },
      { width: window.innerWidth, ...engine.camera.insets },
      'center',
    )
  }
  const ref = useFollow<HTMLDivElement>(engine, place)
  const style = place()
  if (ids.length < 2 || engine.doc.readOnly || !style) return null

  // 选中的 Frame 里的素材也算
  const seen = new Set<string>()
  const assets: Array<{ assetId: string; name: string }> = []
  const media: MediaTarget[] = []
  for (const id of ids) {
    for (const el of [engine.doc.get(id), ...engine.doc.descendants(id)]) {
      if (!el || seen.has(el.id)) continue
      seen.add(el.id)
      const m = elementMedia(el)
      if (!m) continue
      assets.push({ assetId: m.assetId, name: el.name ?? `${el.kind}-${assets.length + 1}` })
      media.push({ elId: el.id, ...m })
    }
  }

  const arrange = () => {
    if (!engine.arrange(ids)) notify('所选元素已经很整齐了')
  }
  const download = () => {
    const n = downloadAll(assets)
    notify(`开始下载 ${n} 个文件`)
  }
  // 模板以 Frame 为单位：先打组，再把这个组存下来
  const save = () => saveAsTemplate(engine, null, '我的模板')

  const btn = 'ui-bar-btn'
  return (
    <div
      role="toolbar"
      ref={ref}
      aria-label="多选操作"
      style={style}
      className="ui-bar ui-bar-sm pointer-events-auto fixed z-20 h-auto w-max flex-wrap"
    >
      <span className="ui-bar-text">已选 {ids.length}</span>
      <div className="ui-bar-sep" />
      {remote && (
        <button
          type="button"
          className={btn}
          title="打开小满，带上所选元素，说说要怎么处理"
          onClick={() => useAgent.getState().ask()}
        >
          <Icon name="wand" size={14} />
          让小满处理
        </button>
      )}
      {remote && <div className="ui-bar-sep" />}
      <button type="button" className={btn} title="整理所选（按连线自动排布）" onClick={arrange}>
        <Icon name="arrange" size={14} />
        整理
      </button>
      <button
        type="button"
        className={btn}
        title={withShortcut('打组', 'mod+g')}
        onClick={() => engine.groupSelection()}
      >
        <Icon name="group" size={14} />
        打组
      </button>
      <button
        type="button"
        className={btn}
        title={`${withShortcut('复制一份', 'mod+d')}，所选元素之间的连线一起复制`}
        onClick={() => engine.duplicateSelection()}
      >
        <Icon name="copy" size={14} />
        复制一份
      </button>
      {remote && <MediaBatchTools engine={engine} targets={media} />}
      {remote && (
        <button
          type="button"
          className={btn}
          disabled={assets.length === 0}
          title={assets.length ? '下载所选元素的原文件' : '所选元素里没有图片、视频或音频'}
          onClick={download}
        >
          <Icon name="download" size={14} />
          下载{assets.length ? `（${assets.length}）` : ''}
        </button>
      )}
      {remote && <LibraryAdd media={mediaIn(engine, ids)} variant="bar" />}
      {remote && (
        <button
          type="button"
          className={btn}
          title="打成一组并存为模板"
          onClick={() => void save()}
        >
          <Icon name="layers" size={14} />
          存为模板
        </button>
      )}
    </div>
  )
}
