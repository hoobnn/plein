import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, elementMedia, primaryResult } from '@plein/doc'
import { useMemo, useRef, useState } from 'react'
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
import { EmptyState } from '../ui/EmptyState'
import { boardReadingOrder } from './boardReadingOrder'

/** 故事板卡片的最大高度 */
const MEDIA_MAX_H = 320

type Column = Exclude<OutlineType, 'frame' | 'other'>
type Filter = 'all' | 'done' | 'todo'
type Filters = Partial<Record<Column, Filter>>

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
  if (el.kind === 'markdown') return el.text?.trim() ? { type: 'text', text: el.text } : null
  const v = el.kind === 'node' ? primaryResult(el)?.value : undefined
  if (v?.type === 'text') return { type: 'text', text: v.text }
  const m = elementMedia(el)
  return m && { type: m.kind, assetId: m.assetId }
}

/**
 * 故事板视图（左上角的“工作流 / 故事板”切换）：
 * 画布上的内容按类型分成并排的几栏（文本、图片、视频、音频），每栏按画布上的阅读顺序
 * （先上后下、先左后右）排列，显示当前结果或“待生成”，适合检查一组镜头的进度。
 * 单栏可以展开铺满；点名称回到画布并定位，点媒体查看或播放。
 */
export function Board() {
  const engine = useCanvas((s) => s.engine)
  const mode = useCanvas((s) => s.mode)
  const [filters, setFilters] = useState<{ engine: Engine | null; values: Filters }>({
    engine,
    values: {},
  })
  if (filters.engine !== engine) setFilters({ engine, values: {} })
  if (!engine || mode !== 'board') return null
  return (
    <BoardPanel
      engine={engine}
      filters={filters.values}
      onFilter={(type, value) => {
        if (useCanvas.getState().engine !== engine) return
        setFilters((current) => ({ engine, values: { ...current.values, [type]: value } }))
      }}
    />
  )
}

function BoardPanel({
  engine,
  filters,
  onFilter,
}: {
  engine: Engine
  filters: Filters
  onFilter(type: Column, value: Filter): void
}) {
  const catalog = useCatalog((s) => s.catalog)
  const version = useDocVersion(engine.doc)
  const [expanded, setExpanded] = useState<Column | null>(null)

  // oxlint-disable react-hooks/exhaustive-deps -- version 变化即文档变化
  const columns = useMemo(() => {
    const items = [...engine.doc.elements()]
      .filter((el) => el.kind !== 'frame' && el.kind !== 'sequence')
      .flatMap((el) => {
        const r = engine.scene.rect(el.id)
        return r ? [{ el, id: el.id, x: r.x, y: r.y }] : []
      })
    return COLUMNS.map((c) => ({
      ...c,
      items: boardReadingOrder(items.filter(({ el }) => outlineType(el) === c.type)).map(
        ({ el }) => el,
      ),
    })).filter((c) => c.items.length > 0)
  }, [engine, catalog, version])
  // oxlint-enable react-hooks/exhaustive-deps

  // 已展开的类别可能被本地或协作删除；退出展开，避免把其他类别一起藏掉。
  if (expanded && !columns.some((column) => column.type === expanded)) setExpanded(null)

  const locate = (id: string) => {
    const state = useCanvas.getState()
    if (state.engine !== engine || state.mode !== 'board') return
    if (!engine.doc.has(id)) {
      state.notify('元素已被删除，无法定位')
      return
    }
    switchMode('flow')
    engine.selection.set([id])
    requestAnimationFrame(() => {
      const current = useCanvas.getState()
      if (
        current.engine === engine &&
        engine.doc.has(id) &&
        engine.selection.size === 1 &&
        engine.selection.has(id)
      )
        engine.zoomToFit([id])
    })
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
          filter={filters[c.type] ?? 'all'}
          onFilter={(value) => onFilter(c.type, value)}
          expanded={expanded === c.type}
          onExpand={() => setExpanded(expanded === c.type ? null : c.type)}
          onLocate={locate}
        />
      ))}
      {!columns.length && <EmptyState fill icon="board" title="画布上还没有内容" />}
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
  filter,
  onFilter,
}: {
  type: Column
  label: string
  items: CanvasElement[]
  expanded: boolean
  onExpand(): void
  onLocate(id: string): void
  filter: Filter
  onFilter(value: Filter): void
}) {
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
        <MenuSelect<Filter> value={filter} options={FILTERS} onChange={onFilter} label="筛选" />
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
  const localUrl = useCanvas((s) => s.localAssetUrls?.get(assetId ?? ''))
  const meta = useAssetMeta(localUrl ? undefined : assetId)
  const title = outlineTitle(el, catalog)
  const status = el.run && STATUS[el.run.status]

  const result = el.kind === 'node' ? primaryResult(el) : undefined
  const candidates = result ? (el.results?.filter((r) => r.port === result.port).length ?? 0) : 0
  const preview = useRef<HTMLButtonElement>(null)
  const thumb =
    localUrl ??
    (assetId
      ? assetUrls.variant(
          assetId,
          type === 'image' ? 'thumb-1024' : type === 'video' ? 'poster' : 'waveform',
        )
      : undefined)
  const [load, setLoad] = useState({ src: thumb, attempt: 0, broken: false })
  const current = load.src === thumb ? load : { src: thumb, attempt: 0, broken: false }
  if (load.src !== thumb) setLoad(current)

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
    const state = useCanvas.getState()
    const latest = state.engine?.doc.get(el.id)
    if (!latest || state.mode !== 'board') {
      onLocate()
      return
    }
    const media = elementMedia(latest)
    if (media) {
      const current = latest.kind === 'node' ? primaryResult(latest) : undefined
      state.view(
        current
          ? { kind: 'result', nodeId: latest.id, resultId: current.id, name: title }
          : { assetId: media.assetId, kind: media.kind, name: title },
      )
    } else onLocate()
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
        ref={preview}
        type="button"
        onClick={open}
        aria-label={assetId ? `查看${title}` : `定位${title}`}
        // 竖图按高度封顶，宽度随比例缩，不裁画面
        style={{ aspectRatio: aspect, width: `min(100%, ${Math.round(MEDIA_MAX_H * aspect)}px)` }}
        className="board-media group"
      >
        {assetId &&
          (current.broken ? (
            <span
              role="img"
              aria-label={`「${title}」缩略图加载失败`}
              className="flex flex-col items-center gap-2 text-xs text-ink-subtle"
            >
              <Icon name={outlineIcon(type)} size={24} />
              缩略图加载失败
            </span>
          ) : (
            <img
              key={JSON.stringify([current.src, current.attempt])}
              src={current.src}
              alt=""
              loading="lazy"
              draggable={false}
              onError={() =>
                setLoad((old) =>
                  old.src === current.src && old.attempt === current.attempt
                    ? { ...old, broken: true }
                    : old,
                )
              }
              className={`size-full ${type === 'audio' ? 'object-contain p-4 opacity-80' : 'object-cover'}`}
            />
          ))}
        {assetId && type !== 'image' && !current.broken && (
          <span className="board-play">
            <Icon name="play" size={20} />
          </span>
        )}
        {!assetId && (
          <span className="flex flex-col items-center gap-2 text-sm text-ink-subtle">
            <Icon name={outlineIcon(type)} size={24} />
            {el.run?.status === 'running' || el.run?.status === 'queued' ? '生成中…' : '待生成'}
          </span>
        )}
        {candidates > 1 && (
          <span className="ui-badge absolute top-2 right-2" aria-label={`${candidates} 个候选`}>
            {candidates}
          </span>
        )}
      </button>
      {current.broken && (
        <button
          type="button"
          aria-label={`重新加载「${title}」缩略图`}
          title="只重新加载缩略图，不改变采用结果"
          className="ui-btn ui-btn-secondary ui-btn-sm"
          onClick={() => {
            preview.current?.focus()
            setLoad((old) => ({ ...old, attempt: old.attempt + 1, broken: false }))
          }}
        >
          <Icon name="retry" size={14} />
          重试缩略图
        </button>
      )}
      {(chips.length > 0 || status) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c, i) => (
            <span key={c} className="board-chip" title={i === 0 && model ? '所用模型' : undefined}>
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
