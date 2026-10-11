import type { Tool } from '@plein/canvas-core'
import { createElement, type NewElement } from '@plein/doc'
import type { ReactNode } from 'react'
import { useCanvas } from '../stores/canvas'

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
  {
    label: '节点',
    input: {
      kind: 'node',
      nodeType: '文生图',
      w: 240,
      h: 180,
      ports: {
        inputs: [{ id: 'prompt', label: '提示词', type: 'text' }],
        outputs: [{ id: 'out', label: '输出', type: 'image' }],
      },
    },
  },
]

/** 底部工具栏：工具切换、新建元素、撤销重做、缩放 */
export function Toolbar() {
  const { engine, tool, zoom, canUndo, canRedo } = useCanvas()
  if (!engine) return null

  const add = (input: Omit<NewElement, 'x' | 'y'>) => {
    const c = engine.camera.viewRect
    const id = createElement(engine.doc, {
      ...input,
      x: Math.round(c.x + c.w / 2 - input.w / 2),
      y: Math.round(c.y + c.h / 2 - input.h / 2),
    } as NewElement)
    engine.selection.set([id])
    engine.setTool('select')
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
