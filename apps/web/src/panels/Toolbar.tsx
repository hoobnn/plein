import type { Tool } from '@plein/canvas-core'
import type { NewElement } from '@plein/doc'
import type { NodeCategory } from '@plein/plugin-sdk'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { type NodeInfo, nodeElement, placeElement } from '../canvas/nodes'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { CATEGORY_LABELS } from './CanvasMenus'

function Button(props: {
  label: string
  hint?: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={props.hint ? `${props.label}（${props.hint}）` : props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-sm transition-colors duration-150 ease-[var(--ease-spring)] disabled:opacity-30 ${
        props.active ? 'bg-accent/15 text-accent' : 'text-ink-muted hover:bg-white/5 hover:text-ink'
      }`}
    >
      {props.children}
    </button>
  )
}

const Divider = () => <div className="mx-1 h-5 w-px bg-line" />

const TOOLS: Array<{ tool: Tool; label: string; hint: string; icon: string }> = [
  { tool: 'select', label: '选择', hint: 'V', icon: '↖' },
  { tool: 'hand', label: '抓手', hint: 'H', icon: '✋' },
]

const NEW_ITEMS: Array<{ label: string; input: Omit<NewElement, 'x' | 'y'> }> = [
  { label: 'Frame', input: { kind: 'frame', w: 640, h: 400, name: '新场景' } },
  { label: 'Markdown', input: { kind: 'markdown', w: 280, h: 200, text: '# 新文档' } },
]

const EMPTY_NODES: NodeInfo[] = []

/** 节点菜单：按插件目录列出已安装的节点，按类别分组 */
function NodeMenu({ onPick }: { onPick(node: NodeInfo): void }) {
  const nodes = useCatalog((s) => s.catalog?.nodes ?? EMPTY_NODES)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])
  if (nodes.length === 0) return null
  const groups = new Map<NodeCategory, NodeInfo[]>()
  for (const n of nodes) groups.set(n.category, [...(groups.get(n.category) ?? []), n])
  return (
    <div ref={ref} className="relative">
      <Button label="新建节点" active={open} onClick={() => setOpen(!open)}>
        + 节点
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-10 left-0 max-h-96 w-64 overflow-y-auto rounded-xl bg-surface p-1 shadow-[var(--shadow-3)]"
        >
          {[...groups].map(([cat, list]) => (
            <div key={cat}>
              <div className="px-2 pb-1 pt-2 text-xs text-ink-muted">{CATEGORY_LABELS[cat]}</div>
              {list.map((n) => (
                <button
                  key={`${n.type}@${n.version}`}
                  type="button"
                  role="menuitem"
                  title={n.description}
                  onClick={() => {
                    setOpen(false)
                    onPick(n)
                  }}
                  className="flex w-full flex-col items-start rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/5"
                >
                  <span>{n.title}</span>
                  {n.description && (
                    <span className="line-clamp-1 text-xs text-ink-muted">{n.description}</span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 底部工具栏：工具切换、新建元素、撤销重做、缩放 */
export function Toolbar({ canImport }: { canImport: boolean }) {
  const { engine, tool, zoom, canUndo, canRedo } = useCanvas()
  const fileRef = useRef<HTMLInputElement>(null)
  // 右键菜单“导入文件…”借用这里的文件选择框
  useEffect(() => {
    const pick = () => fileRef.current?.click()
    window.addEventListener('plein:import-pick', pick)
    return () => window.removeEventListener('plein:import-pick', pick)
  }, [])
  if (!engine) return null

  const add = (input: Omit<NewElement, 'x' | 'y'>) => {
    const c = engine.camera.viewRect
    placeElement(engine, input, { x: c.x + c.w / 2, y: c.y + c.h / 2 })
  }

  return (
    <div className="pointer-events-auto flex items-center gap-0.5 rounded-xl bg-surface/85 p-1 shadow-[var(--shadow-3)] backdrop-blur-xl">
      {TOOLS.map((t) => (
        <Button
          key={t.tool}
          label={t.label}
          hint={t.hint}
          active={tool === t.tool}
          onClick={() => engine.setTool(t.tool)}
        >
          {t.icon}
        </Button>
      ))}
      <Divider />
      {NEW_ITEMS.map((item) => (
        <Button key={item.label} label={`新建 ${item.label}`} onClick={() => add(item.input)}>
          + {item.label}
        </Button>
      ))}
      <NodeMenu onPick={(n) => add(nodeElement(n))} />
      {canImport && (
        <>
          <Button
            label="导入文件"
            hint="也可以直接拖入或粘贴"
            onClick={() => fileRef.current?.click()}
          >
            导入
          </Button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            accept="image/*,video/*,audio/*,.md,.markdown,.txt"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])]
              e.target.value = ''
              if (files.length)
                window.dispatchEvent(new CustomEvent('plein:import', { detail: files }))
            }}
          />
        </>
      )}
      <Divider />
      <Button label="撤销" hint="⌘Z" disabled={!canUndo} onClick={() => engine.undo()}>
        ↶
      </Button>
      <Button label="重做" hint="⇧⌘Z" disabled={!canRedo} onClick={() => engine.redo()}>
        ↷
      </Button>
      <Divider />
      <Button label="缩小" onClick={() => engine.zoomTo(zoom / 1.25)}>
        −
      </Button>
      <Button label="缩放到 100%" hint="⌘0" onClick={() => engine.zoomTo(1)}>
        <span className="w-11 tabular-nums">{Math.round(zoom * 100)}%</span>
      </Button>
      <Button label="放大" onClick={() => engine.zoomTo(zoom * 1.25)}>
        +
      </Button>
      <Button label="适应画布" hint="⇧1" onClick={() => engine.zoomToFit()}>
        ⤢
      </Button>
    </div>
  )
}
