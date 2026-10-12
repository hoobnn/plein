import type { CanvasMenuEvent, Engine } from '@plein/canvas-core'
import { currentResult, setResultRating } from '@plein/doc'
import { type ReactNode, useEffect, useRef } from 'react'
import { findNode, type NodeInfo } from '../canvas/nodes'
import { describeGroupRun, runGroup, templateData } from '../canvas/groups'
import { runNode } from '../canvas/runner'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { useTemplates } from '../stores/templates'
import { promptDialog } from '../ui/Dialog'
import { Stars } from '../ui/Stars'
import { AddMenu } from './AddMenu'

const MENU_W = 280

/** 菜单定位：贴着光标，超出视口时往回收 */
function placeAt(x: number, y: number, h: number, w = MENU_W) {
  return {
    left: Math.min(x, window.innerWidth - w - 8),
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
      canImport={canImport}
      onClose={close}
    />
  )
}

const PICKER_W = 240
const PICKER_H = 440

/** 双击空白、拉线到空白：在光标处弹添加节点菜单，选中后落在光标处（拉线时自动连上） */
function NodePicker({
  engine,
  menu,
  canImport,
  onClose,
}: {
  engine: Engine
  menu: Extract<CanvasMenuEvent, { kind: 'create' | 'connect' }>
  canImport: boolean
  onClose(): void
}) {
  const ref = useDismiss(onClose)
  const pos = placeAt(menu.client.x, menu.client.y, PICKER_H, PICKER_W)
  return (
    <div ref={ref} className="fixed z-30" style={pos}>
      <AddMenu
        engine={engine}
        from={menu.kind === 'connect' ? menu.from : undefined}
        at={() => menu.world}
        canImport={canImport}
        onClose={onClose}
        style={{ width: PICKER_W, maxHeight: PICKER_H }}
      />
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
      className={`ui-menu-item justify-between ${props.danger ? '!text-danger hover:!bg-danger-soft' : ''}`}
    >
      <span>{props.label}</span>
      {props.hint && <span className="ui-kbd">{props.hint}</span>}
    </button>
  )
}

const Sep = () => <div className="ui-sep" />

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
  const notify = useCanvas((s) => s.notify)
  const runFrame = async (id: string, video: boolean) => {
    const r = await runGroup(id, { video })
    if (r) notify(describeGroupRun(engine.doc.get(id)?.name ?? 'Frame', r))
  }
  const saveFrame = async (id: string) => {
    const title = await promptDialog({
      title: '存为模板',
      message: '存好后，双击画布空白处，在「我的模板」里找到它。',
      defaultValue: engine.doc.get(id)?.name ?? 'Frame',
      placeholder: '模板名称',
      confirmLabel: '保存',
    })
    if (!title) return
    try {
      await useTemplates.getState().save(title, templateData(engine, id))
      notify(`已存为模板「${title}」，双击空白处在“我的模板”里找到`)
    } catch (err) {
      notify((err as Error).message)
    }
  }
  const ids = engine.selection.values()
  const single = ids.length === 1 ? engine.scene.get(ids[0]!) : undefined
  const node: NodeInfo | undefined =
    single?.kind === 'node' ? findNode(catalog, single.nodeType) : undefined
  const rated = single?.kind === 'node' ? currentResult(single) : undefined
  const ratable = rated && rated.value.type !== 'text' && rated.value.type !== 'json'
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
        {node?.executable && node.execution === 'job' && single && (
          <>
            <Item label="生成" hint="⌘↵" onClick={act(() => void runNode(single.id))} />
            <Sep />
          </>
        )}
        {single?.kind === 'frame' && canImport && (
          <>
            <Item label="运行整组" onClick={act(() => void runFrame(single.id, false))} />
            <Item label="运行整组（含视频）" onClick={act(() => void runFrame(single.id, true))} />
            <Item label="存为模板…" onClick={act(() => void saveFrame(single.id))} />
            <Sep />
          </>
        )}
        {ratable && single && !engine.doc.readOnly && (
          <>
            <div className="flex h-8 items-center justify-between px-2">
              <span>评级</span>
              <Stars
                value={rated.rating}
                onChange={(n) => {
                  onClose()
                  setResultRating(engine.doc, single.id, rated.id, n)
                }}
              />
            </div>
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
      className="ui-menu pointer-events-auto fixed z-30"
    >
      {items}
    </div>
  )
}
