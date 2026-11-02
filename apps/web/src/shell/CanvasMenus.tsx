import { useEngineVersion } from '../canvas/hooks'
import { isEditableTarget, type CanvasMenuEvent, type Engine } from '@plein/canvas-core'
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { applyCast, castLibrary, castOf, describeCast } from '../canvas/cast'
import { findNode, type NodeInfo } from '../canvas/nodes'
import { nodeRegistration } from '../canvas/node-registry'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { shortcut } from '../ui/keys'
import { useDismiss } from '../ui/useDismiss'
import { AddMenu } from './AddMenu'
import { runFlowFrom, runFrame, runNode } from '../features/runs/run'
import { m } from 'motion/react'
import { AnimatePresence, scaleVariants, useOverlayClosing, useOverlayMotion } from '../ui/motion'
import { saveAsTemplate } from '../features/templates/actions'
import { requestElementRename } from '../canvas/rename'
import { dialogOpen } from '../ui/Dialog'
import { Icon } from '../ui/icons'

const MENU_W = 280

/** 菜单定位：贴着光标，超出视口时往回收 */
function placeAt(x: number, y: number, h: number, w = MENU_W) {
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
  }
}

/** 按布局尺寸定位，避开进场动画的缩放；搜索结果或视口变化后重新贴合边界。 */
function useMenuPosition(
  ref: RefObject<HTMLDivElement | null>,
  { x, y }: { x: number; y: number },
  width: number,
) {
  const [position, setPosition] = useState(() => placeAt(x, y, 0, width))
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const next = placeAt(x, y, el.offsetHeight, el.offsetWidth)
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
  }, [ref, x, y])
  return position
}

/** 画布菜单：双击空白、拉线到空白弹节点选择器；右键弹上下文菜单 */
export function CanvasMenus({ canImport }: { canImport: boolean }) {
  const engine = useCanvas((s) => s.engine)
  const menu = useCanvas((s) => s.menu)
  const setMenu = useCanvas((s) => s.setMenu)
  const close = () => setMenu(null)
  useEffect(() => {
    const rename = (event: KeyboardEvent) => {
      if (
        event.key !== 'F2' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        isEditableTarget(event.target) ||
        dialogOpen() ||
        !engine ||
        engine.doc.readOnly
      )
        return
      const ids = engine.selection.values()
      if (ids.length !== 1) return
      event.preventDefault()
      void requestElementRename(engine, ids[0]!)
    }
    window.addEventListener('keydown', rename)
    return () => window.removeEventListener('keydown', rename)
  }, [engine])
  if (!engine || !menu) return <AnimatePresence>{null}</AnimatePresence>
  if (menu.kind === 'context')
    return (
      <AnimatePresence>
        <ContextMenu engine={engine} menu={menu} canImport={canImport} onClose={close} />
      </AnimatePresence>
    )
  return (
    <AnimatePresence>
      <NodePicker
        key={`${menu.client.x},${menu.client.y}`}
        engine={engine}
        menu={menu}
        canImport={canImport}
        onClose={close}
      />
    </AnimatePresence>
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
  useEngineVersion(engine)
  const ref = useDismiss(onClose, { wheel: true })
  const pos = useMenuPosition(ref, menu.client, PICKER_W)
  useEffect(() => {
    if (engine.doc.readOnly) onClose()
  }, [engine, engine.doc.readOnly, onClose])
  if (engine.doc.readOnly) return null
  return (
    <div
      ref={ref}
      onClickCapture={(event) => {
        if (!engine.doc.readOnly) return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
      onKeyDownCapture={(event) => {
        if (!engine.doc.readOnly) return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
      className="pointer-events-none fixed z-35"
      style={{ ...pos, width: PICKER_W, maxWidth: 'calc(100vw - 16px)' }}
    >
      <AddMenu
        engine={engine}
        from={menu.kind === 'connect' ? menu.from : undefined}
        at={() => menu.world}
        canImport={canImport}
        onClose={onClose}
        style={{ width: '100%', maxHeight: `min(${PICKER_H}px, calc(100dvh - 16px))` }}
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

/** 子菜单留在同一关闭区域内，鼠标可以穿过两列之间的间隙。 */
function CreateSubmenu({
  engine,
  menu,
  canImport,
  onClose,
  anchor,
}: {
  engine: Engine
  menu: Extract<CanvasMenuEvent, { kind: 'context' }>
  canImport: boolean
  onClose(): void
  anchor: { left: number; top: number }
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [focusOnOpen, setFocusOnOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const closeSubmenu = () => {
    setOpen(false)
    trigger.current?.focus()
  }
  const enter = () => {
    setFocusOnOpen(true)
    setOpen(true)
  }
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const button = trigger.current
      const element = panel.current
      if (!button || !element) return
      const rect = button.getBoundingClientRect()
      const width = element.offsetWidth
      const height = element.offsetHeight
      const right = rect.right + 8
      const left =
        right + width <= window.innerWidth - 8
          ? right
          : rect.left - width - 8 >= 8
            ? rect.left - width - 8
            : Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
      const next = {
        left: left - rect.left,
        top: Math.max(8, Math.min(rect.top, window.innerHeight - height - 8)) - rect.top,
      }
      setPosition((prev) => (prev?.left === next.left && prev.top === next.top ? prev : next))
    }
    update()
    const parent = trigger.current?.closest('[role="menu"]')
    const leave = (event: Event) => {
      const item = (event.target as HTMLElement).closest('[role="menuitem"]')
      if (item && item !== trigger.current) setOpen(false)
    }
    parent?.addEventListener('pointerover', leave)
    parent?.addEventListener('focusin', leave)
    window.addEventListener('resize', update)
    const observer = new ResizeObserver(update)
    if (panel.current) observer.observe(panel.current)
    return () => {
      window.removeEventListener('resize', update)
      parent?.removeEventListener('pointerover', leave)
      parent?.removeEventListener('focusin', leave)
      observer.disconnect()
    }
  }, [open, anchor.left, anchor.top])
  useLayoutEffect(() => {
    if (open && position && focusOnOpen) {
      panel.current?.querySelector('input')?.focus({ preventScroll: true })
      setFocusOnOpen(false)
    }
  }, [open, position, focusOnOpen])
  return (
    <div className="relative">
      <button
        ref={trigger}
        type="button"
        role="menuitem"
        aria-haspopup="dialog"
        aria-expanded={open && !engine.doc.readOnly}
        disabled={engine.doc.readOnly}
        className="ui-menu-item justify-between"
        onPointerEnter={() => {
          if (!engine.doc.readOnly) setOpen(true)
        }}
        onClick={enter}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            event.stopPropagation()
            enter()
          }
        }}
      >
        <span>新建节点</span>
        <Icon name="chevronRight" size={16} />
      </button>
      {open && !engine.doc.readOnly && (
        <div
          ref={panel}
          role="group"
          aria-label="新建节点选项"
          className="plein-create-submenu"
          style={{
            ...position,
            opacity: position ? 1 : 0,
            width: 'min(260px, calc(100vw - 16px))',
          }}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
            if (event.key === 'ArrowLeft' || event.key === 'Escape') {
              event.preventDefault()
              closeSubmenu()
            }
          }}
        >
          <button type="button" className="ui-menu-item text-ink-muted" onClick={closeSubmenu}>
            <Icon name="chevronLeft" size={16} />
            新建节点
          </button>
          <AddMenu
            engine={engine}
            canImport={canImport}
            at={() => menu.world}
            onClose={onClose}
            autoFocus={false}
            style={{
              maxHeight: 'min(560px, calc(100dvh - 56px))',
              boxShadow: 'none',
              background: 'transparent',
              animation: 'none',
            }}
          />
        </div>
      )}
    </div>
  )
}

function ContextMenu({
  engine,
  menu,
  canImport,
  onClose,
}: {
  engine: Engine
  menu: Extract<CanvasMenuEvent, { kind: 'context' }>
  canImport: boolean
  onClose(): void
}) {
  useEngineVersion(engine)
  const readOnly = engine.doc.readOnly
  const ref = useDismiss(onClose, { wheel: true })
  const closing = useOverlayClosing()
  const motion = useOverlayMotion(scaleVariants)
  const position = useMenuPosition(ref, menu.client, 220)
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
  const edit = (fn: () => void) => () => {
    if (engine.doc.readOnly) return
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
  // 右键菜单的专属条目（场景准备等）在注册表里登记
  const menuEntry = single?.kind === 'node' ? nodeRegistration(single.nodeType)?.menu : undefined
  // 角色与场景抽取这类节点：结果按固定 Markdown 输出时，可以一键落成设定卡
  const cast = single?.kind === 'node' ? castOf(engine, single.id) : []
  let items: ReactNode
  if (menu.target === null) {
    items = (
      <>
        <CreateSubmenu
          engine={engine}
          menu={menu}
          canImport={canImport}
          onClose={onClose}
          anchor={position}
        />
        <Sep />
        <Item label="适应画布" hint={shortcut('shift+1')} onClick={act(() => engine.zoomToFit())} />
        <Item label="全选" hint={shortcut('mod+a')} onClick={act(() => engine.selectAll())} />
      </>
    )
  } else {
    items = (
      <>
        {single && (
          <Item
            label="重命名…"
            hint="F2"
            disabled={readOnly}
            onClick={edit(() => void requestElementRename(engine, single.id))}
          />
        )}
        {node?.executable && node.execution === 'job' && single && (
          <Item
            label="生成"
            hint={shortcut('mod+enter')}
            disabled={readOnly}
            onClick={edit(() => void runNode(single.id))}
          />
        )}
        {node && single && canImport && (
          <>
            {node.execution === 'job' && (
              <Item
                label="运行到此处"
                hint="含上游"
                disabled={readOnly}
                onClick={edit(() => void flow(single.id, 'upstream'))}
              />
            )}
            <Item
              label="运行下游"
              disabled={readOnly}
              onClick={edit(() => void flow(single.id, 'downstream'))}
            />
            <Sep />
          </>
        )}
        {cast.length > 0 && single && !engine.doc.readOnly && (
          <>
            <Item
              label={`生成设定卡（${cast.length}）`}
              hint="按抽取结果"
              disabled={readOnly}
              onClick={edit(
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
            <Item
              label="运行整组"
              disabled={readOnly}
              onClick={edit(() => void runGroup(single.id, false))}
            />
            <Item
              label="运行整组（含视频）"
              disabled={readOnly}
              onClick={edit(() => void runGroup(single.id, true))}
            />
            <Item
              label="存为模板…"
              disabled={readOnly}
              onClick={edit(() => void saveFrame(single.id))}
            />
            <Sep />
          </>
        )}
        {single && menuEntry && (
          <Item label={menuEntry.label} onClick={act(() => menuEntry.onClick(single.id))} />
        )}
        <Item
          label="复制一份"
          hint={shortcut('mod+d')}
          disabled={readOnly}
          onClick={edit(() => engine.duplicateSelection())}
        />
        <Item
          label="打组"
          hint={shortcut('mod+g')}
          disabled={readOnly}
          onClick={edit(() => engine.groupSelection())}
        />
        {ids.some((id) => engine.scene.get(id)?.kind === 'frame') && (
          <Item
            label="解组"
            hint={shortcut('mod+shift+g')}
            disabled={readOnly}
            onClick={edit(() => engine.ungroupSelection())}
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
          disabled={readOnly}
          onClick={edit(() => engine.bringToFront())}
        />
        <Item
          label="置于底层"
          hint={shortcut('mod+[')}
          disabled={readOnly}
          onClick={edit(() => engine.sendToBack())}
        />
        <Sep />
        <Item
          label="删除"
          hint={shortcut('backspace')}
          danger
          disabled={readOnly}
          onClick={edit(() => engine.deleteSelection())}
        />
      </>
    )
  }
  return (
    <m.div
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
      {...motion}
      style={{
        ...position,
        width: 220,
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: 'calc(100dvh - 16px)',
        overflowY: menu.target === null ? 'visible' : 'auto',
        overscrollBehavior: 'contain',
      }}
      className="ui-menu ui-motion pointer-events-auto fixed z-35"
    >
      {items}
    </m.div>
  )
}
