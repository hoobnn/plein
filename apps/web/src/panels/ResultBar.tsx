import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, currentResult } from '@plein/doc'
import { presetsFor } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { useState } from 'react'
import { assetUrls } from '../api/client'
import { downloadAsset, splitGrid } from '../canvas/grid'
import { deriveNode } from '../canvas/presets'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { Icon } from '../ui/icons'
import { Popover } from '../ui/Popover'
import { useEngineVersion } from './Generator'

/** 节点标题行的高度：工具条放在它上方 */
const TITLE_H = 30
const BAR_H = 40
const TOP_RESERVED = 64

const GRIDS = [
  { rows: 2, cols: 2, label: '4 宫格（2×2）' },
  { rows: 3, cols: 3, label: '9 宫格（3×3）' },
  { rows: 4, cols: 4, label: '16 宫格（4×4）' },
]

/** 元素当前展示的媒体：节点取采用的结果，素材元素取自身资产 */
function mediaOf(el: CanvasElement): { assetId: string; kind: 'image' | 'video' } | null {
  if (el.kind === 'node') {
    const v = currentResult(el)?.value
    return v && (v.type === 'image' || v.type === 'video')
      ? { assetId: v.assetId, kind: v.type }
      : null
  }
  if ((el.kind === 'image' || el.kind === 'video') && el.assetId)
    return { assetId: el.assetId, kind: el.kind }
  return null
}

/** 能接图片输入的某类生成节点（同能力多个时取内置的） */
function nodeFor(catalog: Catalog | null, capability: string) {
  const list = (catalog?.nodes ?? []).filter(
    (n) => n.capability === capability && n.inputs.some((p) => p.type === 'image'),
  )
  return list.find((n) => n.type.startsWith('plein/')) ?? list[0]
}

/**
 * 选中一张有结果的图片 / 视频时浮在它上方的工具条：
 * 预设 = 在右侧派生一个连好、填好提示词的新节点，确认后再生成；
 * 宫格切分在本地完成；下载、全屏查看。
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
  const media = el ? mediaOf(el) : null
  const rect = el && engine.scene.rect(el.id)
  if (!el || !media || !rect || engine.doc.readOnly) return null
  const running = el.run?.status === 'running' || el.run?.status === 'queued'
  if (running) return null

  const tl = engine.worldToClient(rect.x, rect.y)
  const tr = engine.worldToClient(rect.x + rect.w, rect.y)
  const offset = el.kind === 'node' ? TITLE_H : 8
  const top = Math.max(TOP_RESERVED, tl.y - offset - BAR_H - 6)
  const center = (tl.x + tr.x) / 2
  return (
    <Bar
      key={el.id}
      engine={engine}
      el={el}
      media={media}
      catalog={catalog}
      remote={!!canvasId}
      style={{ top, left: center }}
    />
  )
}

function Bar({
  engine,
  el,
  media,
  catalog,
  remote,
  style,
}: {
  engine: Engine
  el: CanvasElement
  media: { assetId: string; kind: 'image' | 'video' }
  catalog: Catalog | null
  remote: boolean
  style: React.CSSProperties
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

  const btn =
    'flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-ink-muted transition-colors hover:bg-hover hover:text-ink aria-expanded:bg-active aria-expanded:text-ink disabled:opacity-40'
  const icon =
    'flex size-8 items-center justify-center rounded-lg text-ink-muted hover:bg-hover hover:text-ink'
  const image = media.kind === 'image'
  return (
    <div
      role="toolbar"
      aria-label="结果操作"
      style={style}
      className="ui-float pointer-events-auto fixed z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-xl p-1"
    >
      {image && imageNode && presets.length > 0 && (
        <button
          type="button"
          className={btn}
          aria-expanded={open?.kind === 'presets'}
          onClick={toggle('presets')}
          title="以这张图为参考，套用预设新建一个图片节点"
        >
          <Icon name="grid" size={14} />
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
          className={btn}
          aria-expanded={open?.kind === 'grid'}
          onClick={toggle('grid')}
          title="把宫格图切成单张图片"
        >
          <Icon name="frame" size={14} />
          宫格切分
          <Icon name="chevronDown" size={12} />
        </button>
      )}
      {image && <div className="mx-0.5 h-4 w-px bg-line" />}
      <button
        type="button"
        className={icon}
        aria-label="下载"
        title="下载原文件"
        onClick={() => downloadAsset(media.assetId, name)}
      >
        <Icon name="download" size={15} />
      </button>
      <button
        type="button"
        className={icon}
        aria-label="全屏查看"
        title="全屏查看"
        onClick={() => view({ ...media, name })}
      >
        <Icon name="expand" size={15} />
      </button>

      {open?.kind === 'presets' && imageNode && (
        <Popover anchor={open.anchor} onClose={() => setOpen(null)} label="预设" width={280}>
          <div className="ui-menu-label">以这张图为参考新建</div>
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              className="ui-menu-item flex-col !items-start !gap-0.5"
              onClick={() => {
                setOpen(null)
                deriveNode(engine, catalog, el.id, imageNode.type, { preset: p })
              }}
            >
              <span className="text-sm">{p.title}</span>
              {p.description && <span className="text-xs text-ink-subtle">{p.description}</span>}
            </button>
          ))}
        </Popover>
      )}
      {open?.kind === 'grid' && (
        <Popover anchor={open.anchor} onClose={() => setOpen(null)} label="宫格切分" width={200}>
          {GRIDS.map((g) => (
            <button
              key={g.label}
              type="button"
              className="ui-menu-item"
              onClick={() => void split(g.rows, g.cols)}
            >
              {g.label}
            </button>
          ))}
        </Popover>
      )}
    </div>
  )
}

/** 全屏查看图片 / 视频：点空白处或 Esc 关闭 */
export function Viewer() {
  const viewer = useCanvas((s) => s.viewer)
  const view = useCanvas((s) => s.view)
  if (!viewer) return null
  const src = assetUrls.original(viewer.assetId)
  return (
    <div
      role="dialog"
      aria-label={`查看「${viewer.name}」`}
      className="fixed inset-0 z-50 flex items-center justify-center p-10"
      onKeyDown={(e) => {
        if (e.key === 'Escape') view(null)
      }}
    >
      <button
        type="button"
        aria-label="关闭"
        tabIndex={-1}
        onClick={() => view(null)}
        className="absolute inset-0 cursor-default bg-black/85 backdrop-blur-sm"
      />
      {viewer.kind === 'image' ? (
        <img
          src={src}
          alt={viewer.name}
          className="relative max-h-full max-w-full rounded-lg object-contain"
        />
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: 生成的视频没有字幕轨
        <video src={src} controls autoPlay className="relative max-h-full max-w-full rounded-lg" />
      )}
      <button
        type="button"
        // biome-ignore lint/a11y/noAutofocus: 打开即可按 Esc 关闭
        autoFocus
        aria-label="关闭"
        onClick={() => view(null)}
        className="absolute right-5 top-5 flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
      >
        <Icon name="x" size={18} />
      </button>
    </div>
  )
}
