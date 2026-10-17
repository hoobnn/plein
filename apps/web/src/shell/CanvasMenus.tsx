import type { CanvasMenuEvent, Engine } from '@plein/canvas-core'
import { type ReactNode, useEffect, useLayoutEffect, useState } from 'react'
import { applyCast, castLibrary, castOf, describeCast } from '../canvas/cast'
import { findNode, type NodeInfo } from '../canvas/nodes'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { shortcut } from '../ui/keys'
import { useDismiss } from '../ui/useDismiss'
import { AddMenu } from './AddMenu'
import { runFlowFrom, runFrame, runNode } from '../features/runs/run'
import { Presence, useClosing, useExit } from '../ui/Presence'
import { saveAsTemplate } from '../features/templates/actions'

const MENU_W = 280

/** 菜单定位：贴着光标，超出视口时往回收 */
function placeAt(x: number, y: number, h: number, w = MENU_W) {
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
  }
}

/** 画布菜单：双击空白、拉线到空白弹节点选择器；右键弹上下文菜单 */
export function CanvasMenus({ canImport }: { canImport: boolean }) {
  const engine = useCanvas((s) => s.engine)
  const menu = useCanvas((s) => s.menu)
  const setMenu = useCanvas((s) => s.setMenu)
  const close = () => setMenu(null)
  if (!engine || !menu) return <Presence>{null}</Presence>
  if (menu.kind === 'context')
    return (
      <Presence>
        <ContextMenu
          engine={engine}
          menu={menu}
          canImport={canImport}
          onClose={close}
          onAddNode={() => setMenu({ ...menu, kind: 'create' })}
        />
      </Presence>
    )
  return (
    <Presence>
      <NodePicker
        key={`${menu.client.x},${menu.client.y}`}
        engine={engine}
        menu={menu}
        canImport={canImport}
        onClose={close}
      />
    </Presence>
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
  const ref = useDismiss(onClose, { wheel: true })
  const pos = placeAt(menu.client.x, menu.client.y, PICKER_H, PICKER_W)
  return (
    <div ref={ref} className="pointer-events-none fixed z-35" style={pos}>
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
      className={`ui-menu-item justify-between ${props.danger ? 'text-danger hover:bg-danger-soft' : ''}`}
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
  const ref = useDismiss(onClose, { wheel: true })
  const exit = useExit()
  const closing = useClosing()
  const [position, setPosition] = useState(() => placeAt(menu.client.x, menu.client.y, 320, 220))
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const next = placeAt(menu.client.x, menu.client.y, el.offsetHeight, el.offsetWidth)
      setPosition((previous) =>
        previous.left === next.left && previous.top === next.top ? previous : next,
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [ref, menu.client.x, menu.client.y])
  useEffect(() => {
    if (closing) {
      // 退场动画保留 DOM，但焦点不能留在已关闭的菜单中拦住下一次画布操作。
      if (ref.current?.contains(document.activeElement))
        (document.activeElement as HTMLElement).blur()
      return
    }
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [closing, ref])
  const catalog = useCatalog((s) => s.catalog)
  const act = (fn: () => void) => () => {
    onClose()
    fn()
  }
  const notify = useCanvas((s) => s.notify)
  const runGroup = (id: string, video: boolean) =>
    runFrame(id, engine.doc.get(id)?.name ?? 'Frame', { video })
  const flow = (id: string, scope: 'upstream' | 'downstream') => {
    const el = engine.doc.get(id)
    return runFlowFrom(id, scope, el?.name ?? findNode(catalog, el?.nodeType)?.title ?? '节点')
  }
  const saveFrame = (id: string) => saveAsTemplate(engine, id, engine.doc.get(id)?.name ?? 'Frame')
  const ids = engine.selection.values()
  const single = ids.length === 1 ? engine.scene.get(ids[0]!) : undefined
  const node: NodeInfo | undefined =
    single?.kind === 'node' ? findNode(catalog, single.nodeType) : undefined
  // 角色与场景抽取这类节点：结果按固定 Markdown 输出时，可以一键落成设定卡
  const cast = single?.kind === 'node' ? castOf(engine, single.id) : []
  let items: ReactNode
  if (menu.target === null) {
    items = (
      <>
        <Item label="添加节点…" hint="双击" onClick={onAddNode} />
        {canImport && (
          <>
            <Item
              label="导入文件…"
              onClick={act(() => window.dispatchEvent(new CustomEvent('plein:import-pick')))}
            />
            <Item
              label="导入文件夹…"
              onClick={act(() => window.dispatchEvent(new CustomEvent('plein:import-pick-folder')))}
            />
          </>
        )}
        <Sep />
        <Item label="适应画布" hint={shortcut('shift+1')} onClick={act(() => engine.zoomToFit())} />
        <Item label="全选" hint={shortcut('mod+a')} onClick={act(() => engine.selectAll())} />
      </>
    )
  } else {
    items = (
      <>
        {node?.executable && node.execution === 'job' && single && (
          <Item
            label="生成"
            hint={shortcut('mod+enter')}
            onClick={act(() => void runNode(single.id))}
          />
        )}
        {node && single && canImport && (
          <>
            {node.execution === 'job' && (
              <Item
                label="运行到此处"
                hint="含上游"
                onClick={act(() => void flow(single.id, 'upstream'))}
              />
            )}
            <Item label="运行下游" onClick={act(() => void flow(single.id, 'downstream'))} />
            <Sep />
          </>
        )}
        {cast.length > 0 && single && !engine.doc.readOnly && (
          <>
            <Item
              label={`生成设定卡（${cast.length}）`}
              hint="按抽取结果"
              onClick={act(
                () =>
                  void castLibrary(cast).then((lib) =>
                    notify(describeCast(applyCast(engine, catalog, single.id, cast, lib))),
                  ),
              )}
            />
            <Sep />
          </>
        )}
        {single?.kind === 'frame' && canImport && (
          <>
            <Item label="运行整组" onClick={act(() => void runGroup(single.id, false))} />
            <Item label="运行整组（含视频）" onClick={act(() => void runGroup(single.id, true))} />
            <Item label="存为模板…" onClick={act(() => void saveFrame(single.id))} />
            <Sep />
          </>
        )}
        <Item
          label="复制一份"
          hint={shortcut('mod+d')}
          onClick={act(() => engine.duplicateSelection())}
        />
        <Item label="打组" hint={shortcut('mod+g')} onClick={act(() => engine.groupSelection())} />
        {ids.some((id) => engine.scene.get(id)?.kind === 'frame') && (
          <Item
            label="解组"
            hint={shortcut('mod+shift+g')}
            onClick={act(() => engine.ungroupSelection())}
          />
        )}
        <Item
          label="缩放到选中"
          hint={shortcut('shift+2')}
          onClick={act(() => engine.zoomToFit(ids))}
        />
        <Sep />
        <Item
          label="置于顶层"
          hint={shortcut('mod+]')}
          onClick={act(() => engine.bringToFront())}
        />
        <Item label="置于底层" hint={shortcut('mod+[')} onClick={act(() => engine.sendToBack())} />
        <Sep />
        <Item
          label="删除"
          hint={shortcut('backspace')}
          danger
          onClick={act(() => engine.deleteSelection())}
        />
      </>
    )
  }
  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
        e.preventDefault()
        e.stopPropagation()
        const items = [
          ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
            '[role="menuitem"]:not(:disabled)',
          ),
        ]
        const current = items.indexOf(document.activeElement as HTMLButtonElement)
        const next =
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? items.length - 1
              : (current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items[next]?.focus()
      }}
      {...exit}
      style={{
        ...position,
        width: 220,
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: 'calc(100dvh - 16px)',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
      }}
      className="ui-menu pointer-events-auto fixed z-35"
    >
      {items}
    </div>
  )
}
