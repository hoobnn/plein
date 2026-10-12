import type { CanvasMenuEvent, Engine } from '@plein/canvas-core'
import type { ReactNode } from 'react'
import { applyCast, castOf, describeCast } from '../canvas/cast'
import { findNode, type NodeInfo } from '../canvas/nodes'
import { templateData } from '../canvas/groups'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { useTemplates } from '../stores/templates'
import { promptDialog } from '../ui/Dialog'
import { shortcut } from '../ui/keys'
import { useDismiss } from '../ui/useDismiss'
import { AddMenu } from './AddMenu'
import { runFlowFrom, runFrame, runNode } from './run'

const MENU_W = 280

/** 菜单定位：贴着光标，超出视口时往回收 */
function placeAt(x: number, y: number, h: number, w = MENU_W) {
  return {
    left: Math.min(x, window.innerWidth - w - 8),
    top: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
  }
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
  const ref = useDismiss(onClose, { wheel: true })
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
  // 角色与场景抽取这类节点：结果按固定 Markdown 输出时，可以一键落成设定卡
  const cast = single?.kind === 'node' ? castOf(engine, single.id) : []
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
              onClick={act(() => notify(describeCast(applyCast(engine, catalog, single.id, cast))))}
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
      style={{ ...placeAt(menu.client.x, menu.client.y, 320), width: 220 }}
      className="ui-menu pointer-events-auto fixed z-30"
    >
      {items}
    </div>
  )
}
