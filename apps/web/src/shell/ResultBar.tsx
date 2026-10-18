import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, currentResult, elementMedia } from '@plein/doc'
import { presetsFor } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { useState } from 'react'
import { mediaOf, splitGrid } from '../canvas/grid'
import { useEngineVersion, useFollow } from '../canvas/hooks'
import { beginImport } from '../canvas/importProgress'
import { importLocation, watchImportView } from '../canvas/importView'
import { revealImports } from '../canvas/import'
import {
  continueNodeFor,
  continueShot,
  playheadOf,
  type ContinuePoint,
} from '../canvas/continueShot'
import { formatTimecode, parseTimecode } from '../canvas/media'
import { deriveNode } from '../canvas/presets'
import { regionEditNode, startRegionEdit } from '../canvas/regionEdit'
import { MaskEditor } from '../features/generator/MaskEditor'
import { type NoticeAction, useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { Icon } from '../ui/icons'
import { Popover } from '../ui/Popover'
import { Presence } from '../ui/Presence'
import { LibraryAdd } from '../features/library/LibraryAdd'
import { MediaTools } from './MediaTools'
import { AssetDownloadButton } from './AssetDownloadButton'

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
  const [open, setOpen] = useState<{
    kind: 'presets' | 'grid' | 'continue'
    anchor: HTMLElement
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [masking, setMasking] = useState(false)
  const editNode = media.kind === 'image' ? regionEditNode(catalog) : undefined
  const [at, setAt] = useState('')
  const { notify, view } = useCanvas.getState()
  const imageNode = nodeFor(catalog, 'image.generate')
  const videoNode = nodeFor(catalog, 'video.generate')
  const presets = imageNode
    ? presetsFor(catalog?.prompts ?? [], imageNode).filter((p) =>
        p.appliesTo?.includes('image.generate'),
      )
    : []
  const name = el.name ?? (media.kind === 'image' ? '图片' : '视频')
  const toggle =
    (kind: 'presets' | 'grid' | 'continue') => (e: React.MouseEvent<HTMLButtonElement>) => {
      if (kind === 'continue' && open?.kind !== kind) {
        const t = playheadOf(el.id)
        setAt(t ? formatTimecode(t) : '')
      }
      setOpen(open?.kind === kind ? null : { kind, anchor: e.currentTarget })
    }
  const continueNode = media.kind === 'video' ? continueNodeFor(catalog, el) : undefined

  const runContinue = async (point: ContinuePoint) => {
    setOpen(null)
    setBusy(true)
    try {
      await continueShot(engine, catalog, el.id, point)
      notify(
        `已从${'last' in point ? '尾帧' : formatTimecode(point.at)}接出下一个镜头，写好提示词就能生成`,
      )
    } catch (err) {
      notify((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const split = async (rows: number, cols: number) => {
    setOpen(null)
    const batch = beginImport(engine, rows * cols)
    const view = watchImportView(engine, batch.signal)
    const notes: string[] = []
    let action: NoticeAction | undefined
    try {
      const frame = await splitGrid(
        engine,
        el.id,
        media.assetId,
        rows,
        cols,
        batch.progress,
        batch.signal,
      )
      if (frame) {
        if (view.unchanged()) revealImports(engine, [frame])
        else {
          notes.push(`已完成 ${rows * cols} 个镜头切分`)
          action = importLocation(engine, [frame])
        }
      }
    } catch (err) {
      if (!batch.signal.aborted) notes.push((err as Error).message)
    } finally {
      view.dispose()
      batch.finish(notes, action)
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
            deriveNode(engine, catalog, el.id, videoNode.type, {
              name: `${name} · 视频`,
              params: { mode: 'image' },
            })
          }
        >
          <Icon name="video" size={14} />
          生成视频
        </button>
      )}
      {editNode && remote && (
        <button
          type="button"
          className={btn}
          title="框选或涂抹要改的区域，只重画这块，其余保持原图"
          onClick={() => setMasking(true)}
        >
          <Icon name="regionEdit" size={14} />
          局部重绘
        </button>
      )}
      {continueNode && remote && (
        <button
          type="button"
          className={`${btn} ui-btn-menu`}
          aria-expanded={open?.kind === 'continue'}
          disabled={busy}
          onClick={toggle('continue')}
          title="取这段视频的一帧作首帧，在右边接出下一个镜头"
        >
          <Icon name="continueShot" size={14} />
          {busy ? '取帧中…' : '续镜'}
          <Icon name="chevronDown" size={12} />
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
      {(remote || (image && (imageNode || videoNode)) || continueNode || editNode) && (
        <span aria-hidden="true" className="ui-bar-sep" />
      )}
      <AssetDownloadButton
        engine={engine}
        assetId={media.assetId}
        name={name}
        className={icon}
        iconOnly
      />
      <button
        type="button"
        className={icon}
        aria-label="全屏查看"
        title="全屏查看"
        onClick={() => {
          const result = el.kind === 'node' ? currentResult(el) : undefined
          view(
            result
              ? { kind: 'result', nodeId: el.id, resultId: result.id, name }
              : { ...media, name },
          )
        }}
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
        {masking && (
          <MaskEditor
            assetId={media.assetId}
            name={name}
            onClose={() => setMasking(false)}
            onSave={(mask) => {
              setMasking(false)
              startRegionEdit(engine, catalog, el.id, mask, name)
              notify('区域画好了，写一句要改成什么就能生成')
            }}
          />
        )}
      </Presence>
      <Presence>
        {open?.kind === 'continue' && (
          <Popover anchor={open.anchor} onClose={() => setOpen(null)} label="续镜" width={260}>
            <div className="ui-menu-label">取一帧作下一个镜头的首帧</div>
            <button
              type="button"
              className="ui-menu-item"
              onClick={() => void runContinue({ last: true })}
            >
              <span className="ui-menu-text">
                <span>从尾帧续</span>
                <span className="ui-menu-desc">动作和画面接得最顺</span>
              </span>
            </button>
            <form
              className="flex items-end gap-2 px-2 pt-1 pb-1"
              onSubmit={(e) => {
                e.preventDefault()
                const t = parseTimecode(at)
                if (t === null) return notify('时间看不懂，试试 3.5 或 0:03.5')
                void runContinue({ at: t })
              }}
            >
              <label className="ui-field min-w-0 flex-1">
                <span className="ui-label">从第几秒续</span>
                <input
                  className="ui-input"
                  value={at}
                  placeholder="播放到想要的画面再点续镜"
                  onChange={(e) => setAt(e.target.value)}
                />
              </label>
              <button type="submit" className="ui-btn ui-btn-sm" disabled={!at.trim()}>
                续
              </button>
            </form>
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
