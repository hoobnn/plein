import type { Engine, Tool } from '@plein/canvas-core'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useCanvas } from '../stores/canvas'
import { Icon, type IconName } from '../ui/icons'
import { Popover } from '../ui/Popover'
import { AddMenu } from './AddMenu'
import { Minimap } from './Minimap'
import { useActiveRuns } from './Tasks'

function Button(props: {
  label: string
  hint?: string
  active?: boolean
  disabled?: boolean
  expanded?: boolean
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  children: ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      title={props.hint ? `${props.label}（${props.hint}）` : props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      aria-expanded={props.expanded}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`ui-bar-btn ${props.className ?? ''}`}
    >
      {props.children}
    </button>
  )
}

const Divider = () => <div className="ui-bar-sep" />

const TOOLS: Array<{ tool: Tool; label: string; hint: string; icon: IconName }> = [
  { tool: 'select', label: '移动', hint: 'V', icon: 'cursor' },
  { tool: 'hand', label: '抓手工具', hint: 'H', icon: 'hand' },
]

/** 工具切换：一个按钮显示当前工具，弹层里选（省一格） */
function ToolPicker({ engine, tool }: { engine: Engine; tool: Tool }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const current = TOOLS.find((t) => t.tool === tool) ?? TOOLS[0]!
  return (
    <>
      <Button
        label="工具"
        hint={`${current.label} ${current.hint}`}
        expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        <Icon name={current.icon} />
      </Button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} label="工具" width={168}>
          {TOOLS.map((t) => (
            <button
              key={t.tool}
              type="button"
              aria-pressed={t.tool === tool}
              onClick={() => {
                engine.setTool(t.tool)
                setAnchor(null)
              }}
              className="ui-menu-item justify-between aria-pressed:bg-active"
            >
              <span className="flex items-center gap-2.5">
                <Icon name={t.icon} />
                {t.label}
              </span>
              <span className="ui-kbd">{t.hint}</span>
            </button>
          ))}
        </Popover>
      )}
    </>
  )
}

/** 添加节点：实心的“+”，菜单在按钮上方弹出，新元素落在视口中央 */
function NodeMenu({ engine, canImport }: { engine: Engine; canImport: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', key)
    }
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title="添加节点（Tab）"
        aria-label="添加节点"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="plein-add-btn"
      >
        <Icon name="plus" size={18} />
      </button>
      {open && (
        <AddMenu
          engine={engine}
          canImport={canImport}
          at={() => {
            const c = engine.camera.viewRect
            return { x: c.x + c.w / 2, y: c.y + c.h / 2 }
          }}
          onClose={() => setOpen(false)}
          className="absolute bottom-12 left-0"
          style={{ width: 240, maxHeight: 'min(440px, calc(100vh - 120px))' }}
        />
      )}
    </div>
  )
}

/** 底部中间：创作入口——添加节点、工具、上传、任务、生成历史、快捷键 */
export function Toolbar({ canImport }: { canImport: boolean }) {
  const engine = useCanvas((s) => s.engine)
  const tool = useCanvas((s) => s.tool)
  const history = useCanvas((s) => s.history)
  const shortcuts = useCanvas((s) => s.shortcuts)
  const tasks = useCanvas((s) => s.tasks)
  const running = useActiveRuns(engine)
  const fileRef = useRef<HTMLInputElement>(null)
  // 右键菜单、添加菜单里的“上传”借用这里的文件选择框
  useEffect(() => {
    const pick = () => fileRef.current?.click()
    window.addEventListener('plein:import-pick', pick)
    return () => window.removeEventListener('plein:import-pick', pick)
  }, [])
  if (!engine) return null

  return (
    <div className="ui-bar pointer-events-auto">
      <NodeMenu engine={engine} canImport={canImport} />
      <ToolPicker engine={engine} tool={tool} />
      {canImport && (
        <>
          <Button label="上传" hint="也可以直接拖入或粘贴" onClick={() => fileRef.current?.click()}>
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
      <Divider />
      {canImport && (
        <Button
          label="任务"
          hint={running ? `${running} 个排队或运行中` : undefined}
          active={tasks}
          onClick={() => useCanvas.getState().toggleTasks()}
          className="relative"
        >
          <Icon name="tasks" />
          {running > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-2xs font-medium tabular-nums text-on-accent">
              {running}
            </span>
          )}
        </Button>
      )}
      <Button
        label="生成历史"
        active={history}
        onClick={() => useCanvas.getState().toggleHistory()}
      >
        <Icon name="history" />
      </Button>
      <Button
        label="快捷键"
        hint="?"
        active={shortcuts}
        onClick={() => useCanvas.getState().toggleShortcuts()}
      >
        <Icon name="keyboard" />
      </Button>
    </div>
  )
}

const ZOOM_PRESETS = [0.5, 1, 2]

/** 缩放下拉：可直接输入百分比，下面是放大、缩小、适应画布和几个常用倍数 */
function ZoomMenu({ engine, zoom }: { engine: Engine; zoom: number }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [draft, setDraft] = useState('')
  const close = () => setAnchor(null)
  const act = (fn: () => void) => () => {
    fn()
    close()
  }
  return (
    <>
      <Button
        label="缩放选项"
        expanded={!!anchor}
        onClick={(e) => {
          setDraft(String(Math.round(zoom * 100)))
          setAnchor(anchor ? null : e.currentTarget)
        }}
        className="!px-2.5"
      >
        <span className="text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
      </Button>
      {anchor && (
        <Popover anchor={anchor} onClose={close} label="缩放" width={200}>
          <label className="ui-input mb-1 flex items-center gap-1">
            <input
              // biome-ignore lint/a11y/noAutofocus: 打开就能输入倍数
              autoFocus
              value={draft}
              inputMode="numeric"
              aria-label="缩放百分比"
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key !== 'Enter') return
                const n = Number(draft)
                if (n > 0) engine.zoomTo(n / 100)
                close()
              }}
              className="min-w-0 flex-1 bg-transparent tabular-nums outline-none"
            />
            <span className="text-ink-subtle">%</span>
          </label>
          <ZoomItem label="放大" hint="⌘ +" onClick={act(() => engine.zoomTo(zoom * 1.25))} />
          <ZoomItem label="缩小" hint="⌘ −" onClick={act(() => engine.zoomTo(zoom / 1.25))} />
          <ZoomItem label="适应画布" hint="⇧ 1" onClick={act(() => engine.zoomToFit())} />
          <div className="ui-sep" />
          {ZOOM_PRESETS.map((z) => (
            <ZoomItem
              key={z}
              label={`缩放至 ${z * 100}%`}
              hint={z === 1 ? '⌘ 0' : undefined}
              onClick={act(() => engine.zoomTo(z))}
            />
          ))}
        </Popover>
      )}
    </>
  )
}

function ZoomItem(props: { label: string; hint?: string; onClick(): void }) {
  return (
    <button type="button" onClick={props.onClick} className="ui-menu-item justify-between">
      <span>{props.label}</span>
      {props.hint && <span className="ui-kbd">{props.hint}</span>}
    </button>
  )
}

/** 左下角：视图控制——撤销重做、整理画布、小地图、隐藏连线、缩放 */
export function ViewControls() {
  const engine = useCanvas((s) => s.engine)
  const zoom = useCanvas((s) => s.zoom)
  const canUndo = useCanvas((s) => s.canUndo)
  const canRedo = useCanvas((s) => s.canRedo)
  const edgesHidden = useCanvas((s) => s.edgesHidden)
  const [minimap, setMinimap] = useState(false)
  if (!engine) return null
  return (
    <div className="pointer-events-none flex flex-col items-start gap-2">
      {minimap && <Minimap engine={engine} />}
      <div className="ui-bar pointer-events-auto">
        <Button label="撤销" hint="⌘Z" disabled={!canUndo} onClick={() => engine.undo()}>
          <Icon name="undo" />
        </Button>
        <Button label="重做" hint="⇧⌘Z" disabled={!canRedo} onClick={() => engine.redo()}>
          <Icon name="redo" />
        </Button>
        <Divider />
        <Button
          label="整理画布"
          hint="⌥⇧F"
          onClick={() => {
            if (!engine.arrange()) useCanvas.getState().notify('画布已经很整齐了')
          }}
        >
          <Icon name="arrange" />
        </Button>
        <Button label="小地图" active={minimap} onClick={() => setMinimap(!minimap)}>
          <Icon name="map" />
        </Button>
        <Button
          label={edgesHidden ? '显示连线' : '隐藏连线'}
          hint="只留选中和悬停节点的连线"
          active={edgesHidden}
          onClick={() => engine.setEdgesHidden(!edgesHidden)}
        >
          <Icon name="route" />
        </Button>
        <Divider />
        <ZoomMenu engine={engine} zoom={zoom} />
      </div>
    </div>
  )
}
