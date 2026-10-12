import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, currentResult, elementPorts, type Port } from '@plein/doc'
import { useMemo, useState } from 'react'
import { assetUrls } from '../api/client'
import { useDocVersion } from '../canvas/hooks'
import { findNode } from '../canvas/nodes'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { Icon, type IconName } from '../ui/icons'

type Kind = Port['type']
type Filter = 'all' | 'done' | 'todo'

const SECTIONS: Array<{ type: Kind; label: string; icon: IconName }> = [
  { type: 'image', label: '图片', icon: 'image' },
  { type: 'video', label: '视频', icon: 'video' },
  { type: 'audio', label: '音频', icon: 'audio' },
  { type: 'text', label: '文本', icon: 'text' },
]

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'done', label: '已生成' },
  { id: 'todo', label: '待生成' },
]

const STATUS: Record<string, { label: string; tone: string }> = {
  queued: { label: '排队中', tone: '' },
  running: { label: '生成中', tone: 'ui-tag-accent' },
  failed: { label: '失败', tone: 'ui-tag-danger' },
  canceled: { label: '已取消', tone: '' },
}

/** 节点主要产出的类型：第一个输出端口 */
const kindOf = (el: CanvasElement): Kind | undefined => elementPorts(el)?.outputs[0]?.type

/**
 * 故事板视图（左上角的“工作流 / 故事板”切换）：
 * 同一画布里的生成节点按产出类型分栏，按画布上的阅读顺序（先上后下、先左后右）排列，
 * 每张卡显示当前结果或“待生成”，适合检查一组镜头的进度。点卡片回到画布并定位到节点。
 */
export function Board() {
  const engine = useCanvas((s) => s.engine)
  const mode = useCanvas((s) => s.mode)
  if (!engine || mode !== 'board') return null
  return <BoardPanel engine={engine} />
}

function BoardPanel({ engine }: { engine: Engine }) {
  const catalog = useCatalog((s) => s.catalog)
  const version = useDocVersion(engine.doc)
  const [filter, setFilter] = useState<Filter>('all')

  // biome-ignore lint/correctness/useExhaustiveDependencies: version 变化即文档变化
  const groups = useMemo(() => {
    const nodes = [...engine.doc.elements()]
      .filter((el) => {
        const node = el.kind === 'node' ? findNode(catalog, el.nodeType) : undefined
        // 只列调模型生成的节点（有 capability）；文本、角色等输入节点不算镜头
        return !!node?.capability
      })
      .map((el) => ({ el, r: engine.scene.rect(el.id)! }))
      .filter((n) => n.r)
      .sort((a, b) => (Math.abs(a.r.y - b.r.y) > 80 ? a.r.y - b.r.y : a.r.x - b.r.x))
    return SECTIONS.map((s) => ({
      ...s,
      items: nodes
        .filter(({ el }) => kindOf(el) === s.type)
        .filter(({ el }) => {
          if (filter === 'all') return true
          const done = !!currentResult(el)
          return filter === 'done' ? done : !done
        })
        .map(({ el }) => el),
    })).filter((g) => g.items.length > 0)
  }, [engine, catalog, version, filter])

  const open = (id: string) => {
    useCanvas.getState().setMode('flow')
    engine.selection.set([id])
    requestAnimationFrame(() => engine.zoomToFit([id]))
  }

  return (
    <div className="ui-scrollbar absolute inset-0 z-10 overflow-y-auto bg-canvas">
      <div className="mx-auto flex max-w-350 flex-col gap-8 px-6 pt-20 pb-16">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-xl font-semibold">故事板</h2>
          <fieldset aria-label="筛选" className="ui-seg">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
                className="ui-seg-item"
              >
                {f.label}
              </button>
            ))}
          </fieldset>
        </div>
        {groups.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-24 text-center text-sm text-ink-subtle">
            <Icon name="board" size={24} />
            {filter === 'all' ? '画布上还没有生成节点' : '没有符合筛选的节点'}
          </div>
        )}
        {groups.map((g) => (
          <section key={g.type} className="flex flex-col gap-3">
            <h3 className="flex items-center gap-2 text-sm font-medium text-ink-muted">
              <Icon name={g.icon} size={14} />
              {g.label}
              <span className="text-ink-subtle">{g.items.length}</span>
            </h3>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
              {g.items.map((el, i) => (
                <li key={el.id}>
                  <BoardCard el={el} index={i + 1} onOpen={() => open(el.id)} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}

function BoardCard({ el, index, onOpen }: { el: CanvasElement; index: number; onOpen(): void }) {
  const result = currentResult(el)
  const v = result?.value
  const status = el.run && STATUS[el.run.status]
  const count = el.results?.length ?? 0
  return (
    <button type="button" onClick={onOpen} className="board-card group">
      <div className="board-thumb">
        {v?.type === 'image' && (
          <img
            src={assetUrls.variant(v.assetId, 'thumb-1024')}
            alt=""
            loading="lazy"
            draggable={false}
            className="size-full object-cover"
          />
        )}
        {v?.type === 'video' && (
          <img
            src={assetUrls.variant(v.assetId, 'poster')}
            alt=""
            loading="lazy"
            draggable={false}
            className="size-full object-cover"
          />
        )}
        {v?.type === 'audio' && (
          <img
            src={assetUrls.variant(v.assetId, 'waveform')}
            alt=""
            loading="lazy"
            draggable={false}
            className="size-full object-contain p-4 opacity-80"
          />
        )}
        {v?.type === 'text' && (
          <p className="line-clamp-6 p-3 text-left text-xs leading-relaxed text-ink-muted">
            {v.text}
          </p>
        )}
        {!v && (
          <span className="text-xs text-ink-subtle">
            {status?.label === '生成中' ? '生成中…' : '待生成'}
          </span>
        )}
        {v?.type === 'video' && (
          <span className="ui-badge absolute bottom-2 left-2">
            <Icon name="play" size={12} />
          </span>
        )}
        <span className="ui-badge board-index">{index}</span>
        {count > 1 && <span className="ui-badge board-count">{count}</span>}
      </div>
      <div className="flex items-center gap-2 px-1 pt-2">
        <span className="min-w-0 flex-1 truncate text-left text-sm">{el.name ?? '未命名'}</span>
        {status && <span className={`ui-tag ${status.tone}`}>{status.label}</span>}
      </div>
    </button>
  )
}
