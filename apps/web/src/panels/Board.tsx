import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, currentResult } from '@plein/doc'
import { useMemo, useState } from 'react'
import { assetUrls } from '../api/client'
import { useDocVersion } from '../canvas/hooks'
import { selectedModel } from '../canvas/modelParams'
import { findNode } from '../canvas/nodes'
import { type OutlineType, outlineIcon, outlineTitle, outlineType } from '../canvas/outline'
import { useAssetMeta } from '../stores/assetMeta'
import { switchMode, useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { Icon } from '../ui/icons'
import { MenuSelect } from '../ui/MenuSelect'

/** 故事板卡片的最大高度 */
const MEDIA_MAX_H = 320

type Column = Exclude<OutlineType, 'frame' | 'other'>
type Filter = 'all' | 'done' | 'todo'

const COLUMNS: Array<{ type: Column; label: string }> = [
  { type: 'text', label: '文本' },
  { type: 'image', label: '图片' },
  { type: 'video', label: '视频' },
  { type: 'audio', label: '音频' },
]

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'done', label: '已生成' },
  { value: 'todo', label: '待生成' },
]

const STATUS: Record<string, { label: string; tone: string }> = {
  queued: { label: '排队中', tone: '' },
  running: { label: '生成中', tone: 'ui-tag-accent' },
  failed: { label: '失败', tone: 'ui-tag-danger' },
  canceled: { label: '已取消', tone: '' },
}

/** 元素当前展示的内容：素材本身，或节点当前采用的结果 */
type Content =
  | { type: 'text'; text: string }
  | { type: 'image' | 'video' | 'audio'; assetId: string }
  | null

function contentOf(el: CanvasElement): Content {
  if (el.kind === 'node') {
    const v = currentResult(el)?.value
    if (!v) return null
    if (v.type === 'text') return { type: 'text', text: v.text }
    if (v.type === 'image' || v.type === 'video' || v.type === 'audio')
      return { type: v.type, assetId: v.assetId }
    return null
  }
  if (el.kind === 'markdown') return el.text?.trim() ? { type: 'text', text: el.text } : null
  if ((el.kind === 'image' || el.kind === 'video' || el.kind === 'audio') && el.assetId)
    return { type: el.kind, assetId: el.assetId }
  return null
}

/**
 * 故事板视图（左上角的“工作流 / 故事板”切换）：
 * 画布上的内容按类型分成并排的几栏（文本、图片、视频、音频），每栏按画布上的阅读顺序
 * （先上后下、先左后右）排列，显示当前结果或“待生成”，适合检查一组镜头的进度。
 * 单栏可以展开铺满；点名称回到画布并定位，点图片 / 视频全屏查看。
 */
export function Board() {
  const engine = useCanvas((s) => s.engine)
  const mode = useCanvas((s) => s.mode)
  if (!engine || mode !== 'board') return null
  return <BoardPanel engine={engine} />
}

function BoardPanel({ engine }: { engine: Engine }) {
  const catalog = useCatalog((s) => s.catalog)
  const version = useDocVersion(engine.doc)
  const [expanded, setExpanded] = useState<Column | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: version 变化即文档变化
  const columns = useMemo(() => {
    const items = [...engine.doc.elements()]
      .filter((el) => el.kind !== 'frame' && el.kind !== 'sequence')
      .map((el) => ({ el, r: engine.scene.rect(el.id)! }))
      .filter((n) => n.r)
      .sort((a, b) => (Math.abs(a.r.y - b.r.y) > 80 ? a.r.y - b.r.y : a.r.x - b.r.x))
      .map((n) => n.el)
    return COLUMNS.map((c) => ({
      ...c,
      items: items.filter((el) => outlineType(el) === c.type),
    })).filter((c) => c.items.length > 0)
  }, [engine, catalog, version])

  const locate = (id: string) => {
    switchMode('flow')
    engine.selection.set([id])
    requestAnimationFrame(() => engine.zoomToFit([id]))
  }

  const shown = expanded ? columns.filter((c) => c.type === expanded) : columns
  return (
    <div className="absolute inset-0 z-10 flex gap-3 overflow-x-auto bg-canvas px-3 pt-17 pb-3">
      {shown.map((c) => (
        <BoardColumn
          key={c.type}
          type={c.type}
          label={c.label}
          items={c.items}
          expanded={expanded === c.type}
          onExpand={() => setExpanded(expanded === c.type ? null : c.type)}
          onLocate={locate}
        />
      ))}
      {!columns.length && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-ink-subtle">
          <Icon name="board" size={24} />
          画布上还没有内容
        </div>
      )}
    </div>
  )
}

function BoardColumn({
  type,
  label,
  items,
  expanded,
  onExpand,
  onLocate,
}: {
  type: Column
  label: string
  items: CanvasElement[]
  expanded: boolean
  onExpand(): void
  onLocate(id: string): void
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const shown = items.filter((el) =>
    filter === 'all' ? true : (contentOf(el) !== null) === (filter === 'done'),
  )
  const done = items.filter((el) => contentOf(el)).length
  return (
    <section aria-label={label} className="board-col">
      <header className="flex h-14 flex-none items-center gap-2 pr-3 pl-5">
        <h2 className="text-base font-medium">{label}</h2>
        <span className="text-xs text-ink-subtle tabular-nums">
          {type === 'text' ? items.length : `${done}/${items.length}`}
        </span>
        <span className="flex-1" />
        <MenuSelect<Filter> value={filter} options={FILTERS} onChange={setFilter} label="筛选" />
        <button
          type="button"
          onClick={onExpand}
          aria-label={expanded ? '还原分栏' : '展开此栏'}
          title={expanded ? '还原分栏' : '展开此栏'}
          className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
        >
          <Icon name={expanded ? 'collapse' : 'expand'} size={14} />
        </button>
      </header>
      <ul
        className={`ui-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-5 ${
          expanded && type !== 'text'
            ? 'grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] content-start gap-x-6'
            : ''
        }`}
      >
        {shown.map((el) =>
          type === 'text' ? (
            <TextItem key={el.id} el={el} onLocate={() => onLocate(el.id)} />
          ) : (
            <MediaItem key={el.id} el={el} type={type} onLocate={() => onLocate(el.id)} />
          ),
        )}
        {!shown.length && (
          <li className="py-16 text-center text-xs text-ink-subtle">没有符合筛选的内容</li>
        )}
      </ul>
    </section>
  )
}

function TextItem({ el, onLocate }: { el: CanvasElement; onLocate(): void }) {
  const catalog = useCatalog((s) => s.catalog)
  const c = contentOf(el)
  const status = el.run && STATUS[el.run.status]
  return (
    <li>
      <button type="button" onClick={onLocate} className="board-text group">
        <span className="board-text-icon">
          <Icon name={outlineIcon('text')} size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm">{outlineTitle(el, catalog)}</span>
            {status && <span className={`ui-tag ${status.tone}`}>{status.label}</span>}
          </span>
          {c?.type === 'text' && (
            <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-ink-subtle">
              {c.text}
            </span>
          )}
        </span>
      </button>
    </li>
  )
}

function MediaItem({
  el,
  type,
  onLocate,
}: {
  el: CanvasElement
  type: Exclude<Column, 'text'>
  onLocate(): void
}) {
  const catalog = useCatalog((s) => s.catalog)
  const c = contentOf(el)
  const assetId = c && c.type !== 'text' ? c.assetId : undefined
  const meta = useAssetMeta(assetId)
  const title = outlineTitle(el, catalog)
  const status = el.run && STATUS[el.run.status]

  // 卡片比例：有素材按素材，没有按画布上的卡片形状（视频节点卡片跟随所选比例）
  const ratio =
    type === 'audio'
      ? 4
      : meta?.width && meta.height
        ? meta.width / meta.height
        : el.w > 0 && el.h > 0
          ? el.w / el.h
          : 16 / 9
  const aspect = Math.min(21 / 9, Math.max(9 / 16, ratio))

  const node = el.kind === 'node' ? findNode(catalog, el.nodeType) : undefined
  const model = node && selectedModel(catalog, node, el.params)?.info.title
  const seconds =
    meta?.duration ?? (typeof el.params?.duration === 'number' ? el.params.duration : 0)
  const chips = [
    model,
    seconds ? `${Math.round(seconds)}秒` : undefined,
    meta?.width && meta.height ? `${meta.width} × ${meta.height}` : undefined,
  ].filter((s): s is string => !!s)

  const open = () => {
    if (assetId && (type === 'image' || type === 'video'))
      useCanvas.getState().view({ assetId, kind: type, name: title })
    else onLocate()
  }

  return (
    <li className="board-item">
      <button
        type="button"
        onClick={onLocate}
        title="在画布上定位"
        className="block max-w-full truncate text-sm text-ink-subtle hover:text-ink"
      >
        {title}
      </button>
      <button
        type="button"
        onClick={open}
        aria-label={assetId ? `查看${title}` : `定位${title}`}
        // 竖图按高度封顶，宽度随比例缩，不裁画面
        style={{ aspectRatio: aspect, width: `min(100%, ${Math.round(MEDIA_MAX_H * aspect)}px)` }}
        className="board-media group"
      >
        {assetId && type === 'image' && (
          <img
            src={assetUrls.variant(assetId, 'thumb-1024')}
            alt=""
            loading="lazy"
            draggable={false}
            className="size-full object-cover"
          />
        )}
        {assetId && type === 'video' && (
          <>
            <img
              src={assetUrls.variant(assetId, 'poster')}
              alt=""
              loading="lazy"
              draggable={false}
              className="size-full object-cover"
            />
            <span className="board-play">
              <Icon name="play" size={20} />
            </span>
          </>
        )}
        {assetId && type === 'audio' && (
          <img
            src={assetUrls.variant(assetId, 'waveform')}
            alt=""
            loading="lazy"
            draggable={false}
            className="size-full object-contain p-4 opacity-80"
          />
        )}
        {!assetId && (
          <span className="flex flex-col items-center gap-2 text-sm text-ink-subtle">
            <Icon name={outlineIcon(type)} size={24} />
            {el.run?.status === 'running' || el.run?.status === 'queued' ? '生成中…' : '待生成'}
          </span>
        )}
        {(el.results?.length ?? 0) > 1 && (
          <span className="ui-badge absolute top-2 right-2">{el.results!.length}</span>
        )}
      </button>
      {(chips.length > 0 || status) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c, i) => (
            <span key={c} className="board-chip">
              {i === 0 && model && <Icon name="sparkle" size={12} />}
              {c}
            </span>
          ))}
          {status && <span className={`ui-tag ${status.tone}`}>{status.label}</span>}
        </div>
      )}
    </li>
  )
}
