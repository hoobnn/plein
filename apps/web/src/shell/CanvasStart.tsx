import type { Engine } from '@plein/canvas-core'
import { findNode, nodeElement, placeElement } from '../canvas/nodes'
import { focusGenerator } from '../canvas/presets'
import { useDocVersion } from '../canvas/hooks'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { useSession } from '../stores/session'
import { Icon, type IconName } from '../ui/icons'

const STARTS: Array<{ type: string; title: string; detail: string; icon: IconName }> = [
  { type: 'plein/character', title: '角色', detail: '建立人物形象', icon: 'character' },
  { type: 'plein/scene', title: '场景', detail: '设定故事发生地', icon: 'scene' },
  { type: 'plein/image', title: '图片', detail: '从一个画面开始', icon: 'image' },
  { type: 'plein/video', title: '视频', detail: '创作一个动态片段', icon: 'video' },
]

/** 空画布的快捷入口与添加菜单共用节点声明，不运行节点。 */
export function CanvasStart({ engine }: { engine: Engine }) {
  useDocVersion(engine.doc)
  const catalog = useCatalog((s) => s.catalog)
  const principal = useSession((s) => s.info?.principal)
  if (engine.doc.readOnly || !principal || principal.role === 'viewer') return null
  const starts = STARTS.filter((item) => findNode(catalog, item.type))
  if (!starts.length) return null
  return (
    <div className="plein-canvas-start pointer-events-auto" aria-label="选择创作起点">
      {starts.map((item) => (
        <button
          type="button"
          className="plein-canvas-start-card"
          key={item.type}
          aria-label={`新建${item.title}节点`}
          onClick={() => {
            const state = useCanvas.getState()
            const actor = useSession.getState().info?.principal
            const node = findNode(useCatalog.getState().catalog, item.type)
            if (
              state.engine !== engine ||
              !state.canvasId ||
              engine.doc.readOnly ||
              !actor ||
              actor.role === 'viewer' ||
              !node
            )
              return
            const view = engine.camera.viewRect
            const id = placeElement(engine, nodeElement(node), {
              x: view.x + view.w / 2,
              y: view.y + view.h * 0.36,
            })
            focusGenerator(engine, id)
          }}
        >
          <span className="plein-canvas-start-icon">
            <Icon name={item.icon} size={20} />
          </span>
          <span className="min-w-0 text-left">
            <span className="block text-sm font-medium">{item.title}</span>
            <span className="block text-xs text-ink-subtle">{item.detail}</span>
          </span>
        </button>
      ))}
    </div>
  )
}
