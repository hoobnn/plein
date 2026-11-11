import type { Engine } from '@plein/canvas-core'
import { insertDramaTemplate } from '../canvas/start'
import { DRAMA_START } from '../canvas/startQueue'
import { useAgent } from '../features/agent/store'
import { findNode, nodeElement, placeElement } from '../canvas/nodes'
import { focusGenerator } from '../canvas/presets'
import { useDocVersion } from '../canvas/hooks'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { useSession } from '../stores/session'
import { Icon, type IconName } from '../ui/icons'

type Start = { type: string; title: string; detail: string; icon: IconName }
const AGENT_START = 'agent/xiaoman'
const AGENT_PROMPT = '帮我把这个创意做成一分钟短剧：'
const STARTS: Start[] = [
  { type: DRAMA_START, title: '短剧模板', detail: '从创意到成片的完整流程', icon: 'workflow' },
  { type: 'plein/character', title: '角色', detail: '建立人物形象', icon: 'character' },
  { type: 'plein/scene', title: '场景', detail: '设定故事发生地', icon: 'scene' },
  { type: 'plein/image', title: '图片', detail: '从一个画面开始', icon: 'image' },
  { type: 'plein/video', title: '视频', detail: '创作一个动态片段', icon: 'video' },
  { type: AGENT_START, title: '让小满帮我搭', detail: '说出创意，小满搭画布', icon: 'sparkle' },
]

/** 空画布的快捷入口与添加菜单共用节点声明，不运行节点。 */
export function CanvasStart({ engine }: { engine: Engine }) {
  useDocVersion(engine.doc)
  const catalog = useCatalog((s) => s.catalog)
  const principal = useSession((s) => s.info?.principal)
  if (engine.doc.readOnly || !principal || principal.role === 'viewer') return null
  const starts = STARTS.filter(
    (item) =>
      item.type === AGENT_START || item.type === DRAMA_START || findNode(catalog, item.type),
  )
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
            const current = useCatalog.getState().catalog
            const node = current ? findNode(current, item.type) : undefined
            if (item.type === AGENT_START) {
              const id = state.canvasId
              if (!id) return
              useAgent.getState().setDraft(id, AGENT_PROMPT)
              useAgent.getState().toggle(true)
              return
            }
            if (item.type === DRAMA_START) {
              if (
                state.engine !== engine ||
                !state.canvasId ||
                engine.doc.readOnly ||
                !actor ||
                actor.role === 'viewer' ||
                !current
              )
                return
              insertDramaTemplate(engine, current)
              return
            }
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
