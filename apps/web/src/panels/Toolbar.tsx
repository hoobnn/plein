import type { Tool } from '@plein/canvas-core'
import type { NewElement } from '@plein/doc'
import type { NodeCategory } from '@plein/plugin-sdk'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { type NodeInfo, nodeElement, placeElement } from '../canvas/nodes'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { Icon, type IconName } from '../ui/icons'
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
      className={`flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-[10px] px-2 text-[13px] transition-colors duration-150 ease-[var(--ease-spring)] disabled:pointer-events-none disabled:opacity-30 ${
        props.active ? 'bg-accent-soft text-accent' : 'text-ink-muted hover:bg-hover hover:text-ink'
      }`}
    >
      {props.children}
    </button>
  )
}

const Divider = () => <div className="mx-1 h-5 w-px bg-line" />

const TOOLS: Array<{ tool: Tool; label: string; hint: string; icon: IconName }> = [
  { tool: 'select', label: '选择', hint: 'V', icon: 'cursor' },
  { tool: 'hand', label: '抓手', hint: 'H', icon: 'hand' },
]

const NEW_ITEMS: Array<{ label: string; icon: IconName; input: Omit<NewElement, 'x' | 'y'> }> = [
  { label: 'Frame', icon: 'frame', input: { kind: 'frame', w: 640, h: 400, name: '新场景' } },
  {
    label: 'Markdown',
    icon: 'doc',
    input: { kind: 'markdown', w: 280, h: 200, text: '# 新文档' },
  },
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
        <Icon name="sparkle" />
        <span>节点</span>
      </Button>
      {open && (
        <div
          role="menu"
          className="ui-menu ui-scrollbar absolute bottom-12 left-1/2 max-h-96 w-64 -translate-x-1/2 overflow-y-auto"
        >
          {[...groups].map(([cat, list]) => (
            <div key={cat}>
              <div className="ui-menu-label">{CATEGORY_LABELS[cat]}</div>
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
                  className="ui-menu-item flex-col !items-start !gap-0.5"
                >
                  <span>{n.title}</span>
                  {n.description && (
                    <span className="line-clamp-1 text-xs text-ink-subtle">{n.description}</span>
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
    <div className="ui-float pointer-events-auto flex items-center gap-0.5 rounded-[14px] p-1">
      {TOOLS.map((t) => (
        <Button
          key={t.tool}
          label={t.label}
          hint={t.hint}
          active={tool === t.tool}
          onClick={() => engine.setTool(t.tool)}
        >
          <Icon name={t.icon} />
        </Button>
      ))}
      <Divider />
      {NEW_ITEMS.map((item) => (
        <Button key={item.label} label={`新建 ${item.label}`} onClick={() => add(item.input)}>
          <Icon name={item.icon} />
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
            <Icon name="upload" />
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
      <Button
        label="整理画布"
        hint="⌥⇧F"
        onClick={() => {
          if (!engine.arrange()) useCanvas.getState().notify('画布已经很整齐了')
        }}
      >
        <Icon name="arrange" />
      </Button>
      <Divider />
      <Button label="撤销" hint="⌘Z" disabled={!canUndo} onClick={() => engine.undo()}>
        <Icon name="undo" />
      </Button>
      <Button label="重做" hint="⇧⌘Z" disabled={!canRedo} onClick={() => engine.redo()}>
        <Icon name="redo" />
      </Button>
      <Divider />
      <Button label="缩小" onClick={() => engine.zoomTo(zoom / 1.25)}>
        <Icon name="minus" />
      </Button>
      <Button label="缩放到 100%" hint="⌘0" onClick={() => engine.zoomTo(1)}>
        <span className="w-10 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
      </Button>
      <Button label="放大" onClick={() => engine.zoomTo(zoom * 1.25)}>
        <Icon name="plus" />
      </Button>
      <Button label="适应画布" hint="⇧1" onClick={() => engine.zoomToFit()}>
        <Icon name="fit" />
      </Button>
      <Divider />
      <Button label="快捷键" hint="?" onClick={() => useCanvas.getState().toggleShortcuts()}>
        <Icon name="keyboard" />
      </Button>
    </div>
  )
}
