import type { ClipboardData, NewElement } from '@plein/doc'
import type { Engine, PortRef } from '@plein/canvas-core'
import { useMemo, useState } from 'react'
import { dramaNotice, placeDramaTemplate } from '../canvas/drama'
import { placeTemplate } from '../canvas/groups'
import {
  compatibleNodes,
  handlePorts,
  type NodeInfo,
  nodeElement,
  placeElement,
} from '../canvas/nodes'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { useTemplates } from '../stores/templates'
import { Icon, type IconName } from '../ui/icons'
import { useExit } from '../ui/Presence'

const NODE_ICONS: Record<string, IconName> = {
  'plein/text': 'text',
  'plein/llm': 'sparkle',
  'plein/image': 'image',
  'plein/video': 'video',
  'plein/speech': 'mic',
  'plein/music': 'music',
  'plein/character': 'character',
  'plein/scene': 'scene',
}
const CATEGORY_ICONS: Record<NodeInfo['category'], IconName> = {
  input: 'text',
  text: 'sparkle',
  image: 'image',
  video: 'video',
  audio: 'audio',
  story: 'story',
  util: 'sliders',
}

const nodeIcon = (n: NodeInfo): IconName =>
  NODE_ICONS[n.type] ?? CATEGORY_ICONS[n.category] ?? 'workflow'

const BASIC: Array<{
  id: string
  title: string
  hint: string
  icon: IconName
  input: Omit<NewElement, 'x' | 'y'>
}> = [
  {
    id: 'markdown',
    title: 'Markdown',
    hint: '可编辑的文档，也能作为文本连到节点',
    icon: 'doc',
    input: { kind: 'markdown', w: 320, h: 200, text: '# 新文档' },
  },
  {
    id: 'frame',
    title: 'Frame',
    hint: '分组容器，可整组运行、存为模板',
    icon: 'frame',
    input: { kind: 'frame', w: 640, h: 400, name: '新场景' },
  },
]

interface Item {
  id: string
  title: string
  hint?: string
  icon: IconName
  section: string
  /** 在世界坐标 at 处落下 */
  run(at: { x: number; y: number }): void
}

export interface AddMenuProps {
  engine: Engine
  /** 从端口拉线：只列能接上的节点，落下后自动连线 */
  from?: PortRef
  /** 新元素的落点（世界坐标） */
  at(): { x: number; y: number }
  canImport: boolean
  onClose(): void
  className?: string
  style?: React.CSSProperties
  /** 菜单在锚点的哪一侧：从那一侧长出 */
  side?: 'above' | 'below'
}

/**
 * 添加节点菜单：单行图标 + 名称，说明放悬停提示；
 * 顶部直接打字搜索，方向键 / 回车选择；底部是上传、从生成历史选择等资源入口。
 */
export function AddMenu({
  engine,
  from,
  at,
  canImport,
  onClose,
  className = '',
  style,
  side = 'below',
}: AddMenuProps) {
  const exit = useExit()
  const nodes = useCatalog((s) => s.catalog?.nodes)
  const catalog = useCatalog((s) => s.catalog)
  const templates = useTemplates((s) => s.templates)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  const items = useMemo(() => {
    const list: Item[] = []
    const pool = from
      ? compatibleNodes(nodes ?? [], {
          types: handlePorts(engine, from).map((p) => p.type),
          side: from.side,
        })
      : (nodes ?? [])
    for (const n of pool)
      list.push({
        id: `${n.type}@${n.version}`,
        title: n.title,
        hint: n.description,
        icon: nodeIcon(n),
        section: '添加节点',
        run: (p) => placeElement(engine, nodeElement(n), p, from),
      })
    if (!from) {
      for (const b of BASIC)
        list.push({ ...b, section: '添加节点', run: (p) => placeElement(engine, b.input, p) })
      // 短剧模板：铺一整条流水线，只建结构和连线，不触发任何运行
      list.push({
        id: 'builtin/drama',
        title: '短剧模板',
        hint: '创意 → 剧本 → 角色场景 → 分镜 → 镜头图 → 镜头视频 → 配音配乐 → 序列',
        icon: 'workflow',
        section: '内置模板',
        run: (p) =>
          useCanvas.getState().notify(dramaNotice(placeDramaTemplate(engine, catalog, p))),
      })
      for (const t of templates)
        list.push({
          id: t.id,
          title: t.title,
          hint: `${t.data.elements.length} 个元素`,
          icon: 'layers',
          section: '我的模板',
          run: (p) => placeTemplate(engine, t.data as unknown as ClipboardData, p),
        })
      if (canImport) {
        list.push({
          id: 'upload',
          title: '上传',
          hint: '图片、视频、音频或 Markdown，也可以直接拖入或粘贴',
          icon: 'upload',
          section: '添加资源',
          run: () => window.dispatchEvent(new CustomEvent('plein:import-pick')),
        })
        list.push({
          id: 'history',
          title: '从生成历史选择',
          icon: 'history',
          section: '添加资源',
          run: () => useCanvas.getState().toggleHistory(true),
        })
      }
    }
    const q = query.trim().toLowerCase()
    return q
      ? list.filter((i) => `${i.title} ${i.hint ?? ''} ${i.id}`.toLowerCase().includes(q))
      : list
  }, [nodes, catalog, templates, engine, from, query, canImport])

  const pick = (item: Item | undefined) => {
    if (!item) return
    onClose()
    item.run(at())
  }

  let lastSection = ''
  return (
    <div
      role="dialog"
      aria-label="添加节点"
      style={style}
      data-side={side}
      {...exit}
      className={`plein-add-menu pointer-events-auto flex flex-col ${className}`}
    >
      <label className="plein-add-search">
        <Icon name="search" />
        <input
          // biome-ignore lint/a11y/noAutofocus: 弹出即可打字搜索
          autoFocus
          value={query}
          placeholder={from ? `连接「${from.port.label}」` : '添加节点'}
          aria-label="搜索节点"
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(items.length - 1, a + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(0, a - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              pick(items[active])
            }
          }}
        />
      </label>
      <div role="listbox" className="ui-scrollbar min-h-0 overflow-y-auto">
        {items.length === 0 && (
          <p className="px-3 pb-3 pt-1 text-sm text-ink-subtle">没有匹配的节点</p>
        )}
        {items.map((item, i) => {
          const header = item.section !== lastSection && i > 0 ? item.section : null
          lastSection = item.section
          return (
            <div key={item.id}>
              {header && <div className="plein-add-section">{header}</div>}
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                title={item.hint}
                onPointerEnter={() => setActive(i)}
                onClick={() => pick(item)}
                className="plein-add-item"
              >
                <span className="plein-add-icon">
                  <Icon name={item.icon} />
                </span>
                <span className="truncate">{item.title}</span>
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
