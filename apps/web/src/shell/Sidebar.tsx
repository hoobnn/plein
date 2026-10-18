import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, updateElement } from '@plein/doc'
import { LIBRARY_KINDS, libraryKindOfNode } from '@plein/nodes'
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import { assetUrls } from '../api/client'
import { mediaOf } from '../canvas/grid'
import { useDocVersion, useSelectionVersion } from '../canvas/hooks'
import { coverOf, findPlacedCard, placeInputOf } from '../features/library/canvas'
import {
  OUTLINE_TYPES,
  type OutlineType,
  outlineIcon,
  outlineTitle,
  outlineType,
} from '../canvas/outline'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { useLibrary } from '../features/library/store'
import { SIDEBAR_WIDTH, type SidebarTab, useSidebar } from '../stores/sidebar'
import { Icon } from '../ui/icons'
import { InlineTitle } from '../ui/InlineTitle'
import { MenuSelect } from '../ui/MenuSelect'
import { SlidePill, SlideSwap } from '../ui/Slide'
import { KIND_ICONS } from '../features/library/LibraryAdd'
import { EmptyState } from '../ui/EmptyState'
import { startSidebarResize } from './sidebarResize'
import { LibraryReadStatus } from '../features/library/LibraryReadStatus'
import { useLibraryPlacement } from '../features/library/useLibraryPlacement'

const TABS: Array<{ id: SidebarTab; label: string }> = [
  { id: 'layers', label: '画布' },
  { id: 'assets', label: '资产' },
]

type TypeFilter = OutlineType | 'all'
type TreeNavigationKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'
const TYPE_FILTERS: Array<{ value: TypeFilter; label: string }> = [
  { value: 'all', label: '全部类型' },
  ...OUTLINE_TYPES.map((t) => ({ value: t.type, label: t.label })),
]

/**
 * 工作流左侧栏：浮在画布左侧的面板，项目 / 画布留在顶栏里不随它移动。
 * 「画布」页签按分组列出画布上的元素，点选即在画布上选中并定位；「资产」页签列出本项目的资产库条目。
 */
export function Sidebar({ open }: { open: boolean }) {
  const engine = useCanvas((s) => s.engine)
  const canvasId = useCanvas((s) => s.canvasId)
  const { tab, setTab, width } = useSidebar()
  // 资产库在服务端，本地演示没有
  const current = canvasId ? tab : 'layers'
  return (
    // 收起时保留在 DOM 里做滑出动画，inert 让它不可聚焦、不可点
    <aside
      aria-label="侧栏"
      aria-hidden={!open}
      inert={!open}
      data-open={open || undefined}
      className="plein-sidebar"
      style={{ width }}
    >
      <div className="px-3 pt-3 pb-1">
        <div role="tablist" aria-label="侧栏内容" className="ui-slide flex gap-1">
          <SlidePill variant="tab" />
          {TABS.filter((t) => canvasId || t.id === 'layers').map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={current === t.id}
              onClick={() => setTab(t.id)}
              className="plein-sidebar-tab"
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <SlideSwap
        index={TABS.findIndex((t) => t.id === current)}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {current === 'layers' ? (
          engine ? (
            <Layers engine={engine} />
          ) : (
            <div className="flex-1" />
          )
        ) : (
          <Assets engine={engine} />
        )}
      </SlideSwap>
      {engine && (
        <footer className="flex h-10 flex-none items-center border-t border-line px-4">
          {current === 'assets' ? <AssetCount /> : <Count engine={engine} />}
        </footer>
      )}
      <ResizeHandle active={open} />
    </aside>
  )
}

/** 右边缘拖动改宽度；双击恢复默认，聚焦后方向键微调 */
function ResizeHandle({ active }: { active: boolean }) {
  const width = useSidebar((s) => s.width)
  const setWidth = useSidebar((s) => s.setWidth)
  const [dragging, setDragging] = useState(false)
  const cancel = useRef<(() => void) | null>(null)
  // 收起侧栏或离开画布都可能发生在指针松开前。
  useEffect(() => () => cancel.current?.(), [active])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!active || e.button !== 0 || cancel.current) return
    e.preventDefault()
    setDragging(true)
    cancel.current = startSidebarResize(e.currentTarget, e.nativeEvent, () => {
      cancel.current = null
      setDragging(false)
    })
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧栏宽度"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      tabIndex={0}
      title="拖动调整宽度，双击恢复默认"
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={() => setWidth(SIDEBAR_WIDTH.default)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 8
        if (e.key === 'ArrowLeft') setWidth(width - step)
        else if (e.key === 'ArrowRight') setWidth(width + step)
        else return
        e.preventDefault()
        e.stopPropagation()
      }}
      className="plein-sidebar-resize"
    />
  )
}

function Count({ engine }: { engine: Engine }) {
  const version = useDocVersion(engine.doc)
  // oxlint-disable react-hooks/exhaustive-deps -- version 变化即文档变化
  const n = useMemo(
    () => [...engine.doc.elements()].filter((el) => el.kind !== 'frame').length,
    [engine, version],
  )
  // oxlint-enable react-hooks/exhaustive-deps
  return <span className="px-2 text-xs text-ink-subtle tabular-nums">共 {n} 个元素</span>
}

function AssetCount() {
  const { items, projectId, loaded } = useLibrary()
  const n = items.filter((item) => projectId && item.projectId === projectId).length
  return (
    <span className="px-2 text-xs text-ink-subtle tabular-nums">
      {loaded ? `共 ${n} 项资产` : '项目资产'}
    </span>
  )
}

/** 元素中心是否落在没被侧栏等浮层挡住的视口里 */
function inView(engine: Engine, r: { x: number; y: number; w: number; h: number }) {
  const { camera } = engine
  const p = camera.worldToScreen(r.x + r.w / 2, r.y + r.h / 2)
  const { left, top, right, bottom } = camera.insets
  return p.x >= left && p.x <= camera.width - right && p.y >= top && p.y <= camera.height - bottom
}

interface Row {
  el: CanvasElement
  depth: number
  title: string
  type: OutlineType
  /** 分组里有子元素（与是否展开无关） */
  parent: boolean
}

// ── 画布页签：图层树 ─────────────────────────────────

function Layers({ engine }: { engine: Engine }) {
  const catalog = useCatalog((s) => s.catalog)
  const version = useDocVersion(engine.doc)
  const selVersion = useSelectionVersion(engine)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [type, setType] = useState<TypeFilter>('all')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [renaming, setRenaming] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const searchButton = useRef<HTMLButtonElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const typeHintId = useId()
  const pendingRenameFocus = useRef<{ id: string; version: number } | null>(null)
  const restoreSearchFocus = useRef(false)
  useEffect(() => {
    if (!searching && restoreSearchFocus.current) {
      restoreSearchFocus.current = false
      searchButton.current?.focus()
    }
  }, [searching])
  const closeSearch = () => {
    restoreSearchFocus.current = true
    setQuery('')
    setSearching(false)
  }
  const listRef = useRef<HTMLDivElement>(null)
  const prevRows = useRef(new Map<string, Row>())
  const q = query.trim().toLowerCase()
  const filtering = !!q || type !== 'all'
  const typeLabel = TYPE_FILTERS.find((option) => option.value === type)?.label ?? '其他'

  // oxlint-disable react-hooks/exhaustive-deps -- version 变化即文档变化
  const { rows, frames } = useMemo(() => {
    const frames: string[] = []
    const next = new Map<string, Row>()
    const visit = (parentId: string | null, depth: number): Row[] => {
      const out: Row[] = []
      // 绘制顺序从下到上，列表里最上层的排在前面
      for (const id of [...engine.scene.children(parentId)].reverse()) {
        const el = engine.doc.get(id)
        if (!el) continue
        const title = outlineTitle(el, catalog)
        const t = outlineType(el)
        const self = (type === 'all' || t === type) && (!q || title.toLowerCase().includes(q))
        const kids = el.kind === 'frame' ? visit(id, depth + 1) : []
        if (el.kind === 'frame') frames.push(id)
        if (!self && !kids.length) continue
        const parent = engine.scene.children(id).length > 0
        // 没变的行沿用上次的对象，memo 过的行组件就不会重渲染
        const prev = prevRows.current.get(id)
        const row =
          prev &&
          prev.el === el &&
          prev.depth === depth &&
          prev.title === title &&
          prev.type === t &&
          prev.parent === parent
            ? prev
            : { el, depth, title, type: t, parent }
        next.set(id, row)
        out.push(row)
        // 筛选时一律展开，免得命中的元素藏在折叠的分组里
        if (filtering || !collapsed.has(id)) out.push(...kids)
      }
      return out
    }
    const rows = visit(null, 0)
    prevRows.current = next
    return { rows, frames }
  }, [engine, catalog, version, q, type, collapsed, filtering])
  // oxlint-enable react-hooks/exhaustive-deps
  const nested = rows.some((r) => r.parent)
  const tabStop =
    rows.find((row) => row.el.id === focused)?.el.id ??
    rows.find((row) => engine.selection.has(row.el.id))?.el.id ??
    rows[0]?.el.id
  useEffect(() => {
    const pending = pendingRenameFocus.current
    if (!pending || pending.version === version) return
    pendingRenameFocus.current = null
    if (searching && !rows.some((row) => row.el.id === pending.id)) searchInput.current?.focus()
  }, [rows, version, searching])

  // 在画布上选中时：展开所在分组，并把它滚进可视范围
  // oxlint-disable react-hooks/exhaustive-deps -- selVersion 变化即选中变化
  useEffect(() => {
    const ids = engine.selection.values()
    if (!ids.length) return
    const ancestors = new Set<string>()
    for (const id of ids)
      for (let p = engine.scene.parent(id); p; p = engine.scene.parent(p)) ancestors.add(p)
    if ([...ancestors].some((id) => collapsed.has(id)))
      setCollapsed((c) => new Set([...c].filter((id) => !ancestors.has(id))))
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector(`[data-id="${CSS.escape(ids[0]!)}"]`)
        ?.scrollIntoView({ block: 'nearest' }),
    )
  }, [engine, selVersion])
  // oxlint-enable react-hooks/exhaustive-deps

  const toggleFolder = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const allCollapsed = frames.length > 0 && frames.every((id) => collapsed.has(id))

  const pick = (id: string, e: React.MouseEvent | React.KeyboardEvent) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) engine.selection.toggle(id)
    else engine.selection.set([id])
    // 不在可见区域（含被侧栏挡住）才移动镜头，保持当前缩放
    const r = engine.scene.rect(id)
    if (r && !inView(engine, r)) engine.camera.centerOn(r.x + r.w / 2, r.y + r.h / 2)
  }
  const locate = (id: string) => {
    engine.selection.set([id])
    engine.zoomToFit([id])
  }
  const focusRow = (id: string) => {
    const element = listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)
    element?.focus({ preventScroll: true })
    element?.scrollIntoView({ block: 'nearest' })
  }
  const navigate = (id: string, key: TreeNavigationKey) => {
    const index = rows.findIndex((row) => row.el.id === id)
    const row = rows[index]
    if (!row) return
    if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End') {
      const target =
        key === 'Home'
          ? 0
          : key === 'End'
            ? rows.length - 1
            : Math.max(0, Math.min(rows.length - 1, index + (key === 'ArrowDown' ? 1 : -1)))
      focusRow(rows[target]!.el.id)
    } else if (key === 'ArrowLeft') {
      if (row.el.kind === 'frame' && row.parent && !filtering && !collapsed.has(id)) {
        toggleFolder(id)
        focusRow(id)
      } else {
        const parent = engine.scene.parent(id)
        if (parent && rows.some((row) => row.el.id === parent)) focusRow(parent)
      }
    } else if (row.el.kind === 'frame' && row.parent) {
      if (!filtering && collapsed.has(id)) {
        toggleFolder(id)
        focusRow(id)
      } else if (rows[index + 1] && rows[index + 1]!.depth > row.depth) {
        focusRow(rows[index + 1]!.el.id)
      }
    }
  }
  const rename = (id: string, name: string | null, expected: string) => {
    const current = engine.doc.get(id)
    if (name !== null && current && name !== current.name) {
      if (engine.doc.readOnly) {
        setRenaming(null)
        useCanvas.getState().notify('画布已变为只读，名称未保存')
        return
      }
      if ((current.name ?? outlineTitle(current, catalog)) !== expected) {
        if (name === expected) {
          setRenaming(null)
          return
        }
        useCanvas.getState().notify('名称已在其他位置更新，已保留输入；请确认后再次保存')
        return { expected: current.name ?? outlineTitle(current, catalog) }
      }
      const row = listRef.current?.querySelector(`[data-id="${CSS.escape(id)}"]`)
      if (searching && row?.contains(document.activeElement))
        pendingRenameFocus.current = { id, version }
      engine.doc.undo.stopCapturing()
      updateElement(engine.doc, id, { name })
      engine.doc.undo.stopCapturing()
    }
    setRenaming(null)
  }
  // 行组件 memo 过：回调保持同一引用，选中变化时只重渲染选中状态变了的行
  const latest = useRef<LayerActions>(null!)
  latest.current = {
    pick,
    toggle: toggleFolder,
    locate,
    startRename: (id) => !engine.doc.readOnly && setRenaming(id),
    rename,
    focus: setFocused,
    navigate,
  }
  const actions = useMemo<LayerActions>(
    () => ({
      pick: (id, e) => latest.current.pick(id, e),
      toggle: (id) => latest.current.toggle(id),
      locate: (id) => latest.current.locate(id),
      startRename: (id) => latest.current.startRename(id),
      rename: (id, name, expected) => latest.current.rename(id, name, expected),
      focus: (id) => latest.current.focus(id),
      navigate: (id, key) => latest.current.navigate(id, key),
    }),
    [],
  )

  return (
    <>
      <div className="flex flex-none items-center gap-1 px-2 py-2">
        {searching ? (
          <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md bg-surface-2 px-2 text-ink-subtle">
            <Icon name="search" size={14} />
            <input
              ref={searchInput}
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- 点了搜索就是要输入
              autoFocus
              value={query}
              placeholder="搜索名称"
              aria-label="搜索画布元素"
              aria-describedby={type !== 'all' ? typeHintId : undefined}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.nativeEvent.isComposing || e.keyCode === 229) return
                if (e.key === 'Escape') {
                  e.preventDefault()
                  closeSearch()
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-subtle"
            />
            <button
              type="button"
              aria-label="关闭搜索"
              onClick={closeSearch}
              className="flex text-ink-subtle hover:text-ink"
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ) : (
          <>
            <button
              ref={searchButton}
              type="button"
              aria-label="搜索"
              title="搜索"
              onClick={() => setSearching(true)}
              className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
            >
              <Icon name="search" />
            </button>
            <MenuSelect<TypeFilter>
              value={type}
              options={TYPE_FILTERS}
              onChange={setType}
              label="按类型筛选"
            />
            <span className="flex-1" />
            <button
              type="button"
              disabled={!frames.length}
              aria-label={allCollapsed ? '展开全部分组' : '折叠全部分组'}
              title={allCollapsed ? '展开全部分组' : '折叠全部分组'}
              onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(frames))}
              className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
            >
              <Icon name={allCollapsed ? 'expandAll' : 'collapseAll'} />
            </button>
          </>
        )}
      </div>
      {searching && type !== 'all' && (
        <div className="flex flex-none px-3 pb-2">
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm gap-1.5"
            aria-label={`清除类型筛选：${typeLabel}`}
            onClick={() => {
              setType('all')
              searchInput.current?.focus()
            }}
          >
            <Icon name="filter" size={12} />
            <span id={typeHintId}>类型：{typeLabel}</span>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
      <div
        ref={listRef}
        role="tree"
        aria-label="画布元素"
        aria-multiselectable="true"
        className="ui-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2"
      >
        {rows.map((r) => (
          <LayerRow
            key={r.el.id}
            row={r}
            caret={nested}
            selected={engine.selection.has(r.el.id)}
            tabStop={r.el.id === tabStop}
            open={filtering || !collapsed.has(r.el.id)}
            renaming={renaming === r.el.id}
            actions={actions}
          />
        ))}
        {!rows.length && (
          <EmptyState
            compact
            icon={filtering ? 'filter' : 'layers'}
            title={filtering ? '没有符合条件的元素' : '画布上还没有元素'}
          />
        )}
      </div>
    </>
  )
}

interface LayerActions {
  pick(id: string, e: React.MouseEvent | React.KeyboardEvent): void
  toggle(id: string): void
  locate(id: string): void
  startRename(id: string): void
  rename(id: string, name: string | null, expected: string): { expected: string } | void
  focus(id: string): void
  navigate(id: string, key: TreeNavigationKey): void
}

const LayerRow = memo(function LayerRow({
  row: { el, depth, title, type, parent },
  caret,
  selected,
  tabStop,
  open,
  renaming,
  actions,
}: {
  row: Row
  /** 列表里有可展开的分组时才给每行留出箭头的位置，否则整列不缩进 */
  caret: boolean
  selected: boolean
  tabStop: boolean
  open: boolean
  renaming: boolean
  actions: LayerActions
}) {
  const onPick = (e: React.MouseEvent | React.KeyboardEvent) => actions.pick(el.id, e)
  const onToggle = () => actions.toggle(el.id)
  const onLocate = () => actions.locate(el.id)
  const onRename = () => actions.startRename(el.id)
  const onRenamed = (name: string | null, expected: string) => actions.rename(el.id, name, expected)
  const running = el.run?.status === 'running' || el.run?.status === 'queued'
  const failed = el.run?.status === 'failed'
  return (
    <div
      role="treeitem"
      tabIndex={tabStop ? 0 : -1}
      data-id={el.id}
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={el.kind === 'frame' ? open : undefined}
      onClick={onPick}
      onDoubleClick={onRename}
      onFocus={() => actions.focus(el.id)}
      onKeyDown={(e) => {
        if (renaming) return
        if (e.nativeEvent.isComposing || e.keyCode === 229) {
          e.preventDefault()
          e.stopPropagation()
          return
        }
        const key = e.key
        if (key === 'Tab') {
          e.stopPropagation()
          return
        }
        if ((key === 'Enter' || key === ' ') && e.target === e.currentTarget) {
          e.preventDefault()
          e.stopPropagation()
          onPick(e)
        } else if (key === 'F2') {
          e.preventDefault()
          e.stopPropagation()
          onRename()
        } else if (
          key === 'ArrowUp' ||
          key === 'ArrowDown' ||
          key === 'ArrowLeft' ||
          key === 'ArrowRight' ||
          key === 'Home' ||
          key === 'End'
        ) {
          if (e.altKey || e.metaKey || e.ctrlKey) return
          e.preventDefault()
          e.stopPropagation()
          actions.navigate(el.id, key)
        }
      }}
      style={{ paddingLeft: 4 + depth * 20 }}
      className="plein-layer group"
    >
      {el.kind === 'frame' && parent ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={open ? '折叠' : '展开'}
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          className="plein-layer-caret"
        >
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
        </button>
      ) : (
        caret && <span className="w-5 flex-none" />
      )}
      <Thumb el={el} type={type} />
      {renaming ? (
        <InlineTitle
          value={el.name ?? title}
          label="元素名称"
          onDone={onRenamed}
          className="h-7 min-w-0 flex-1 rounded-md px-1.5 text-sm"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
      )}
      {running && <span className="plein-layer-dot bg-accent" title="生成中" />}
      {failed && <span className="plein-layer-dot bg-danger" title="生成失败" />}
      {el.locked && (
        <span className="flex text-ink-subtle" title="已锁定">
          <Icon name="lock" size={12} />
        </span>
      )}
      {!renaming && (
        <button
          type="button"
          tabIndex={-1}
          aria-label="定位到画布"
          title="定位到画布"
          onClick={(e) => {
            e.stopPropagation()
            onLocate()
          }}
          className="plein-layer-action"
        >
          <Icon name="locate" size={14} />
        </button>
      )}
    </div>
  )
})

function assetIcon(el: CanvasElement) {
  const kind = el.kind === 'node' ? libraryKindOfNode(el.nodeType) : undefined
  return kind && KIND_ICONS[kind.id]
}

function Thumb({ el, type }: { el: CanvasElement; type: OutlineType }) {
  const m = mediaOf(el)
  if (el.kind === 'frame')
    return (
      <span className="plein-layer-thumb plein-layer-folder">
        <Icon name="folder" size={16} />
      </span>
    )
  return (
    <span className="plein-layer-thumb">
      {m ? (
        <img
          src={assetUrls.variant(m.assetId, m.kind === 'image' ? 'thumb-256' : 'poster')}
          alt=""
          loading="lazy"
          draggable={false}
          className="size-full object-cover"
        />
      ) : (
        // 设定卡按输出归在「图片」里，图标用资产类别的，和画布上卡片标题一致
        <Icon name={assetIcon(el) ?? outlineIcon(type)} size={16} />
      )}
      {m?.kind === 'video' && (
        <span className="plein-layer-play">
          <Icon name="play" size={12} />
        </span>
      )}
    </span>
  )
}

// ── 资产页签：本项目的资产库条目 ─────────────────────

function Assets({ engine }: { engine: Engine | null }) {
  const placement = useLibraryPlacement(engine)
  const { items, loaded, loading, error, load, projectId, show } = useLibrary()
  const version = useDocVersion(engine?.doc ?? NO_DOC)
  const canPlace = !!engine && !engine.doc.readOnly
  const mine = items.filter((i) => projectId && i.projectId === projectId)
  const groups = LIBRARY_KINDS.map((k) => ({
    kind: k,
    items: mine.filter((i) => i.kind === k.id),
  })).filter((g) => g.items.length)

  // oxlint-disable react-hooks/exhaustive-deps -- version 变化即文档变化
  const placed = useMemo(
    () => new Set(engine ? mine.filter((i) => findPlacedCard(engine, i.id)).map((i) => i.id) : []),
    [engine, version, mine.map((i) => i.id).join()],
  )
  // oxlint-enable react-hooks/exhaustive-deps

  return (
    <>
      <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <LibraryReadStatus loaded={loaded} loading={loading} error={error} load={load} />
        {placement.error && (
          <p role="alert" className="mb-3 rounded-lg bg-danger/5 px-3 py-2 text-xs text-danger">
            {placement.error}。点击条目重试。
          </p>
        )}
        {groups.map((g) => (
          <section key={g.kind.id} className="pb-3">
            <h3 className="flex h-8 items-center gap-2 px-2 text-xs font-medium text-ink-subtle">
              <Icon name={KIND_ICONS[g.kind.id]} size={14} />
              <span className="flex-1">{g.kind.title}</span>
              <span className="tabular-nums">{g.items.length}</span>
            </h3>
            {g.items.map((item) => {
              const cover = coverOf(item)
              const on = placed.has(item.id)
              const input = placeInputOf(item)
              const busy = !!input && placement.isPlacing(input)
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={!canPlace || busy}
                  onClick={() => input && void placement.place(input)}
                  title={on ? '已在画布上，点击选中' : '添加到画布'}
                  className="plein-layer group w-full text-left"
                >
                  <span className="plein-layer-thumb">
                    {cover ? (
                      <img
                        src={cover}
                        alt=""
                        loading="lazy"
                        draggable={false}
                        className="size-full object-cover"
                      />
                    ) : (
                      <Icon name={KIND_ICONS[g.kind.id]} size={16} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
                  {busy ? (
                    <span role="status" className="px-1 text-2xs text-ink-subtle">
                      正在放入…
                    </span>
                  ) : on ? (
                    <span className="px-1 text-2xs text-ink-subtle">已在画布</span>
                  ) : (
                    <span className="plein-layer-action">
                      <Icon name="plus" size={14} />
                    </span>
                  )}
                </button>
              )
            })}
          </section>
        ))}
        {loaded && !loading && !error && !groups.length && (
          <EmptyState
            compact
            icon="library"
            title="本项目还没有资产"
            hint="角色、场景、道具存入资产库后会列在这里"
          />
        )}
      </div>
      <div className="flex-none px-3 pb-3">
        <button
          type="button"
          onClick={() => show('character')}
          className="ui-btn ui-btn-sm w-full gap-1.5"
        >
          <Icon name="library" size={14} />
          打开资产库
        </button>
      </div>
    </>
  )
}

/** 没有引擎时给 useDocVersion 的空订阅 */
const NO_DOC = { subscribe: () => () => {} } as unknown as Engine['doc']
