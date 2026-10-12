import type { CanvasMenuEvent, Engine } from '@plein/canvas-core'
import type { NewElement } from '@plein/doc'
import type { NodeCategory } from '@plein/plugin-sdk'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import {
  compatibleNodes,
  findNode,
  type NodeInfo,
  nodeElement,
  placeElement,
} from '../canvas/nodes'
import { runNode } from '../canvas/runner'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  input: '输入',
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
  story: '短剧',
  util: '工具',
}

const BASIC: Array<{
  id: string
  title: string
  description: string
  input: Omit<NewElement, 'x' | 'y'>
}> = [
  {
    id: 'markdown',
    title: 'Markdown',
    description: '可编辑的文档，也能作为文本连到节点',
    input: { kind: 'markdown', w: 320, h: 200, text: '# 新文档' },
  },
  {
    id: 'frame',
    title: 'Frame',
    description: '分组容器',
    input: { kind: 'frame', w: 640, h: 400, name: '新场景' },
  },
]

const MENU_W = 280

/** 菜单定位：贴着光标，超出视口时往回收 */
function placeAt(x: number, y: number, h: number) {
  return {
    left: Math.min(x, window.innerWidth - MENU_W - 8),
    top: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
  }
}

function useDismiss(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const wheel = (e: WheelEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    window.addEventListener('wheel', wheel, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key)
      window.removeEventListener('wheel', wheel, true)
    }
  }, [onClose])
  return ref
}

/** 画布菜单：双击空白、拉线到空白弹节点选择器；右键弹上下文菜单 */
export function CanvasMenus({ canImport }: { canImport: boolean }) {
  const engine = useCanvas((s) => s.engine)
  const menu = useCanvas((s) => s.menu)
  const setMenu = useCanvas((s) => s.setMenu)
  if (!engine || !menu) return null
  const close = () => setMenu(null)
  if (menu.kind === 'context')
    return (
      <ContextMenu
        engine={engine}
        menu={menu}
        canImport={canImport}
        onClose={close}
        onAddNode={() => setMenu({ ...menu, kind: 'create' })}
      />
    )
  return (
    <NodePicker
      key={`${menu.client.x},${menu.client.y}`}
      engine={engine}
      menu={menu}
      onClose={close}
    />
  )
}

type PickerItem = {
  id: string
  title: string
  description?: string
  group: string
  create(): Omit<NewElement, 'x' | 'y'>
}

/** 可搜索的节点选择器；从端口拉出时只列能接上的节点，选中后自动连线 */
function NodePicker({
  engine,
  menu,
  onClose,
}: {
  engine: Engine
  menu: Extract<CanvasMenuEvent, { kind: 'create' | 'connect' }>
  onClose(): void
}) {
  const nodes = useCatalog((s) => s.catalog?.nodes ?? [])
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const ref = useDismiss(onClose)
  const from = menu.kind === 'connect' ? menu.from : undefined

  const items = useMemo(() => {
    const list: PickerItem[] = []
    const pool = from ? compatibleNodes(nodes, { type: from.port.type, side: from.side }) : nodes
    for (const n of pool) {
      list.push({
        id: `${n.type}@${n.version}`,
        title: n.title,
        description: n.description,
        group: CATEGORY_LABELS[n.category],
        create: () => nodeElement(n),
      })
    }
    // 拉出文本输出时也能落一个 Markdown；空白处双击时可建基础元素
    if (!from) for (const b of BASIC) list.push({ ...b, group: '基础', create: () => b.input })
    const q = query.trim().toLowerCase()
    return q
      ? list.filter((i) => `${i.title} ${i.description ?? ''} ${i.id}`.toLowerCase().includes(q))
      : list
  }, [nodes, from, query])

  const pick = (item: PickerItem | undefined) => {
    if (!item) return
    onClose()
    placeElement(engine, item.create(), menu.world, from)
  }

  const pos = placeAt(menu.client.x, menu.client.y, 360)
  let lastGroup = ''
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="添加节点"
      style={{ ...pos, width: MENU_W }}
      className="pointer-events-auto fixed z-30 flex max-h-[360px] flex-col overflow-hidden rounded-xl bg-surface p-1 shadow-[var(--shadow-3)]"
    >
      <input
        // biome-ignore lint/a11y/noAutofocus: 弹出即输入是选择器的主要用法
        autoFocus
        value={query}
        placeholder={from ? `搜索能接上「${from.port.label}」的节点` : '搜索节点'}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((a) => Math.min(items.length - 1, a + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => Math.max(0, a - 1))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            pick(items[active])
          }
        }}
        className="mb-1 h-9 rounded-lg bg-surface-2 px-3 text-sm outline-none ring-1 ring-line focus:ring-accent/60"
      />
      <div role="listbox" className="overflow-y-auto">
        {items.length === 0 && <p className="px-2 py-3 text-sm text-ink-muted">没有匹配的节点</p>}
        {items.map((item, i) => {
          const header = item.group !== lastGroup ? item.group : null
          lastGroup = item.group
          return (
            <div key={item.id}>
              {header && <div className="px-2 pb-1 pt-2 text-xs text-ink-muted">{header}</div>}
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                onPointerEnter={() => setActive(i)}
                onClick={() => pick(item)}
                className={`flex w-full flex-col items-start rounded-lg px-2 py-1.5 text-left text-sm ${i === active ? 'bg-white/8' : ''}`}
              >
                <span>{item.title}</span>
                {item.description && (
                  <span className="line-clamp-1 text-xs text-ink-muted">{item.description}</span>
                )}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Item(props: {
  label: string
  hint?: string
  danger?: boolean
  disabled?: boolean
  onClick(): void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={props.disabled}
      onClick={props.onClick}
      className={`flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-white/8 disabled:opacity-40 ${props.danger ? 'text-[#ff8a8a]' : ''}`}
    >
      <span>{props.label}</span>
      {props.hint && <span className="text-xs text-ink-muted">{props.hint}</span>}
    </button>
  )
}

const Sep = () => <div className="my-1 h-px bg-line" />

function ContextMenu({
  engine,
  menu,
  canImport,
  onClose,
  onAddNode,
}: {
  engine: Engine
  menu: Extract<CanvasMenuEvent, { kind: 'context' }>
  canImport: boolean
  onClose(): void
  onAddNode(): void
}) {
  const ref = useDismiss(onClose)
  const catalog = useCatalog((s) => s.catalog)
  const act = (fn: () => void) => () => {
    onClose()
    fn()
  }
  const ids = engine.selection.values()
  const single = ids.length === 1 ? engine.scene.get(ids[0]!) : undefined
  const node: NodeInfo | undefined =
    single?.kind === 'node' ? findNode(catalog, single.nodeType) : undefined
  let items: ReactNode
  if (menu.target === null) {
    items = (
      <>
        <Item label="添加节点…" hint="双击" onClick={onAddNode} />
        {canImport && (
          <Item
            label="导入文件…"
            onClick={act(() => window.dispatchEvent(new CustomEvent('plein:import-pick')))}
          />
        )}
        <Sep />
        <Item label="适应画布" hint="⇧1" onClick={act(() => engine.zoomToFit())} />
        <Item label="全选" hint="⌘A" onClick={act(() => engine.selectAll())} />
      </>
    )
  } else {
    items = (
      <>
        {node?.executable && node.capability && single && (
          <>
            <Item label="生成" hint="⌘↵" onClick={act(() => void runNode(single.id))} />
            <Sep />
          </>
        )}
        <Item label="复制一份" hint="⌘D" onClick={act(() => engine.duplicateSelection())} />
        <Item label="打组" hint="⌘G" onClick={act(() => engine.groupSelection())} />
        <Item label="缩放到选中" hint="⇧2" onClick={act(() => engine.zoomToFit(ids))} />
        <Sep />
        <Item label="置于顶层" hint="⌘]" onClick={act(() => engine.bringToFront())} />
        <Item label="置于底层" hint="⌘[" onClick={act(() => engine.sendToBack())} />
        <Sep />
        <Item label="删除" hint="⌫" danger onClick={act(() => engine.deleteSelection())} />
      </>
    )
  }
  return (
    <div
      ref={ref}
      role="menu"
      style={{ ...placeAt(menu.client.x, menu.client.y, 320), width: 220 }}
      className="pointer-events-auto fixed z-30 rounded-xl bg-surface p-1 shadow-[var(--shadow-3)]"
    >
      {items}
    </div>
  )
}
