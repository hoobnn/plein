import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, elementMedia } from '@plein/doc'
import { presetsFor } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { useState } from 'react'
import { downloadAsset, mediaOf, splitGrid } from '../canvas/grid'
import { useEngineVersion, useFollow } from '../canvas/hooks'
import { deriveNode } from '../canvas/presets'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { Icon } from '../ui/icons'
import { Popover } from '../ui/Popover'
import { Presence } from '../ui/Presence'
import { LibraryAdd } from '../features/library/LibraryAdd'
import { MediaTools } from './MediaTools'

const BAR_H = 40
const BOTTOM_RESERVED = 64

const GRIDS = [
  { rows: 2, cols: 2, label: '4 宫格' },
  { rows: 3, cols: 3, label: '9 宫格' },
  { rows: 4, cols: 4, label: '16 宫格' },
]

/** 能接图片输入的某类生成节点（同能力多个时取内置的） */
function nodeFor(catalog: Catalog | null, capability: string) {
  const list = (catalog?.nodes ?? []).filter(
    (n) => n.capability === capability && n.inputs.some((p) => p.type === 'image'),
  )
  return list.find((n) => n.type.startsWith('plein/')) ?? list[0]
}

/**
 * 选中画布上的图片 / 视频素材时浮在它下方的工具条。
 * 生成节点不用它：同样的操作放在节点下方生成器的第一行（见 ResultActions）。
 */
export function ResultBar() {
  const engine = useCanvas((s) => s.engine)
  if (!engine) return null
  return <ResultBarHost engine={engine} />
}

function ResultBarHost({ engine }: { engine: Engine }) {
  useEngineVersion(engine)
  const catalog = useCatalog((s) => s.catalog)
  const canvasId = useCanvas((s) => s.canvasId)
  const ids = engine.selection.values()
  const el = ids.length === 1 ? engine.scene.get(ids[0]!) : undefined
  // 生成节点的结果操作在生成器里；锁定的节点没有生成器，仍用浮动工具条
  const media = el && (el.kind !== 'node' || el.locked) ? mediaOf(el) : null
  // 加工工具要覆盖音频，所以另算一份含音频的
  const asset = el && (el.kind !== 'node' || el.locked) ? elementMedia(el) : null
  const place = () => {
    const rect = el && engine.scene.rect(el.id)
    if (!rect) return null
    const bl = engine.worldToClient(rect.x, rect.y + rect.h)
    const br = engine.worldToClient(rect.x + rect.w, rect.y + rect.h)
    return {
      top: Math.min(bl.y + 12, window.innerHeight - BOTTOM_RESERVED - BAR_H),
      left: (bl.x + br.x) / 2,
    }
  }
  const ref = useFollow<HTMLDivElement>(engine, place)
  const style = place()
  if (!el || (!media && !asset) || !style || engine.doc.readOnly) return null

  return (
    <div
      key={el.id}
      ref={ref}
      role="toolbar"
      aria-label="结果操作"
      style={style}
      className="ui-bar ui-bar-sm pointer-events-auto fixed z-20 w-max -translate-x-1/2"
    >
      {media && (
        <ResultActions
          engine={engine}
          el={el}
          media={media}
          catalog={catalog}
          remote={!!canvasId}
          variant="bar"
        />
      )}
      {asset && canvasId && (
        // key 跟着素材走：换选一个素材时把已读的元信息和打开的表单一起丢掉
        <MediaTools
          key={asset.assetId}
          engine={engine}
          target={{ elId: el.id, ...asset }}
          label="媒体工具"
        />
      )}
    </div>
  )
}

/**
 * 对结果的操作：预设 = 在右侧派生一个连好、填好提示词的新节点，确认后再生成；
 * 生成视频；宫格切分在本地完成；下载、全屏查看。
 * bar 用在素材的浮动工具条里，inline 用在生成器第一行。
 */
export function ResultActions({
  engine,
  el,
  media,
  catalog,
  remote,
  variant,
}: {
  engine: Engine
  el: CanvasElement
  media: { assetId: string; kind: 'image' | 'video' }
  catalog: Catalog | null
  remote: boolean
  variant: 'bar' | 'inline'
}) {
  const [open, setOpen] = useState<{ kind: 'presets' | 'grid'; anchor: HTMLElement } | null>(null)
  const { notify, setImporting, view } = useCanvas.getState()
  const imageNode = nodeFor(catalog, 'image.generate')
  const videoNode = nodeFor(catalog, 'video.generate')
  const presets = imageNode
    ? presetsFor(catalog?.prompts ?? [], imageNode).filter((p) =>
        p.appliesTo?.includes('image.generate'),
      )
    : []
  const name = el.name ?? (media.kind === 'image' ? '图片' : '视频')
  const toggle = (kind: 'presets' | 'grid') => (e: React.MouseEvent<HTMLButtonElement>) =>
    setOpen(open?.kind === kind ? null : { kind, anchor: e.currentTarget })

  const split = async (rows: number, cols: number) => {
    setOpen(null)
    setImporting({ done: 0, total: rows * cols })
    try {
      await splitGrid(engine, el.id, media.assetId, rows, cols, (done, total) =>
        setImporting({ done, total }),
      )
    } catch (err) {
      notify((err as Error).message)
    } finally {
      setImporting(null)
    }
  }

  // 浮动工具条里用工具条按钮；生成器第一行用 28 高的安静按钮，两处图标都是 14
  const btn = variant === 'inline' ? 'ui-btn ui-btn-sm ui-btn-quiet' : 'ui-bar-btn'
  const icon = `${btn} ui-icon-btn`
  const image = media.kind === 'image'
  return (
    <>
      {image && imageNode && presets.length > 0 && (
        <button
          type="button"
          className={`${btn} ui-btn-menu`}
          aria-expanded={open?.kind === 'presets'}
          onClick={toggle('presets')}
          title="以这张图为参考，套用预设新建一个图片节点"
        >
          <Icon name="presets" size={14} />
          预设
          <Icon name="chevronDown" size={12} />
        </button>
      )}
      {image && videoNode && (
        <button
          type="button"
          className={btn}
          title="以这张图为首帧，新建一个视频节点"
          onClick={() =>
            deriveNode(engine, catalog, el.id, videoNode.type, { name: `${name} · 视频` })
          }
        >
          <Icon name="video" size={14} />
          生成视频
        </button>
      )}
      {image && remote && (
        <button
          type="button"
          className={`${btn} ui-btn-menu`}
          aria-expanded={open?.kind === 'grid'}
          onClick={toggle('grid')}
          title="把宫格图切成单张图片"
        >
          <Icon name="gridSplit" size={14} />
          宫格切分
          <Icon name="chevronDown" size={12} />
        </button>
      )}
      {remote && (
        <LibraryAdd media={[{ elId: el.id, ...media, name: el.name ?? '' }]} variant={variant} />
      )}
      {(remote || (image && (imageNode || videoNode))) && (
        <span aria-hidden="true" className="ui-bar-sep" />
      )}
      <button
        type="button"
        className={icon}
        aria-label="下载"
        title="下载原文件"
        onClick={() => downloadAsset(media.assetId, name)}
      >
        <Icon name="download" size={14} />
      </button>
      <button
        type="button"
        className={icon}
        aria-label="全屏查看"
        title="全屏查看"
        onClick={() => view({ ...media, name })}
      >
        <Icon name="expand" size={14} />
      </button>

      <Presence>
        {open?.kind === 'presets' && imageNode && (
          <Popover anchor={open.anchor} onClose={() => setOpen(null)} label="预设" width={280}>
            <div className="ui-menu-label">以这张图为参考新建</div>
            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                className="ui-menu-item"
                onClick={() => {
                  setOpen(null)
                  deriveNode(engine, catalog, el.id, imageNode.type, { preset: p })
                }}
              >
                <span className="ui-menu-text">
                  <span>{p.title}</span>
                  {p.description && <span className="ui-menu-desc">{p.description}</span>}
                </span>
              </button>
            ))}
          </Popover>
        )}
      </Presence>
      <Presence>
        {open?.kind === 'grid' && (
          <Popover anchor={open.anchor} onClose={() => setOpen(null)} label="宫格切分" width={200}>
            {GRIDS.map((g) => (
              <button
                key={g.label}
                type="button"
                className="ui-menu-item justify-between"
                onClick={() => void split(g.rows, g.cols)}
              >
                {g.label}
                <span className="ui-kbd">
                  {g.rows}×{g.cols}
                </span>
              </button>
            ))}
          </Popover>
        )}
      </Presence>
    </>
  )
}
