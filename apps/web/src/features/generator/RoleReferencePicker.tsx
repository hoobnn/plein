import type { Engine } from '@plein/canvas-core'
import { setParam } from '@plein/doc'
import type { PreparedInput } from '@plein/protocol'
import { useState } from 'react'
import { assetUrls } from '../../api/client'
import { Icon } from '../../ui/icons'
import { Popover } from '../../ui/Popover'
import { AnimatePresence } from '../../ui/motion'
import { checkedImages, readPicks, roleViews, togglePick } from './roleReferences'

/** 节点上的角色参考；同一角色的多处引用合并成一个，供按钮、瓦片和占位共用 */
export function useRoleViews(engine: Engine, nodeId: string, data?: PreparedInput | null) {
  return roleViews(
    data,
    readPicks(engine.doc.get(nodeId)?.params),
    (id) => engine.doc.get(id)?.name,
  )
}

/** 顶部「角色参考」按钮：看全部角色 */
export function RoleReferencePicker({
  engine,
  nodeId,
  data,
}: {
  engine: Engine
  nodeId: string
  data?: PreparedInput | null
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const roles = useRoleViews(engine, nodeId, data)
  if (!roles.length) return null
  return (
    <>
      <button
        type="button"
        className="ui-btn ui-btn-sm ui-btn-secondary"
        aria-label="角色参考图"
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        <Icon name="image" size={14} />
        角色参考
      </button>
      <AnimatePresence>
        {anchor && (
          <RoleReferencePopover
            engine={engine}
            nodeId={nodeId}
            data={data}
            anchor={anchor}
            onClose={() => setAnchor(null)}
          />
        )}
      </AnimatePresence>
    </>
  )
}

/**
 * 角色参考图选择器：每张图是一个开关，可以多选。
 * 选择按资产 id 保存，重排角色参考图后也不会换成另一张；没选过是自动，选空是仅文字。
 * 传 elementId 时只显示这个角色（从参考瓦片、占位进来）。
 */
export function RoleReferencePopover({
  engine,
  nodeId,
  data,
  anchor,
  elementId,
  onClose,
}: {
  engine: Engine
  nodeId: string
  data?: PreparedInput | null
  anchor: HTMLElement
  elementId?: string
  onClose(): void
}) {
  const all = useRoleViews(engine, nodeId, data)
  const roles = elementId ? all.filter((role) => role.elementId === elementId) : all
  const select = (id: string, images: string[] | undefined) => {
    const picks = { ...readPicks(engine.doc.get(nodeId)?.params) }
    if (images === undefined) delete picks[id]
    else picks[id] = images
    engine.doc.undo.stopCapturing()
    setParam(engine.doc, nodeId, 'referenceImagePicks', picks)
    engine.doc.undo.stopCapturing()
  }
  return (
    <Popover anchor={anchor} onClose={onClose} label="角色参考图" width={380}>
      <p className="mb-3 text-xs text-ink-subtle">
        自动：只带定妆图；写了 @角色/档案项 时带档案项的图。点图可以加减，选好的图按卡片顺序送入。
      </p>
      <div className="ui-scrollbar flex max-h-80 flex-col gap-4 overflow-y-auto">
        {roles.map((role) => {
          const checked = checkedImages(role)
          const auto = role.picks === undefined
          return (
            <section key={role.elementId} aria-label={`${role.name}参考图`}>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <h4 className="truncate text-sm font-medium">{role.name}</h4>
                <span role="status" className="shrink-0 text-xs text-ink-subtle">
                  {auto
                    ? `自动 · 送入 ${checked.length} 张`
                    : checked.length
                      ? `已选 ${checked.length} 张`
                      : '仅文字，不带图'}
                </span>
              </div>
              <div className="mb-2 flex gap-2">
                <button
                  type="button"
                  className="ui-chip ui-chip-btn"
                  aria-pressed={auto}
                  onClick={() => select(role.elementId, undefined)}
                >
                  {auto ? '自动选择' : '恢复自动'}
                </button>
                <button
                  type="button"
                  className="ui-chip ui-chip-btn"
                  aria-pressed={role.picks?.length === 0}
                  onClick={() => select(role.elementId, [])}
                >
                  仅文字
                </button>
              </div>
              <div
                role="listbox"
                aria-multiselectable="true"
                aria-label={`${role.name}可用图片`}
                className="grid grid-cols-4 gap-2"
              >
                {role.available.map((assetId, i) => {
                  const on = checked.includes(assetId)
                  return (
                    <button
                      key={assetId}
                      type="button"
                      role="option"
                      aria-label={`选择${role.name}第${i + 1}张参考图`}
                      aria-selected={on}
                      className="relative overflow-hidden rounded-lg border border-line p-1 aria-selected:border-accent aria-selected:bg-accent/10"
                      onClick={() => select(role.elementId, togglePick(role, assetId))}
                    >
                      <img
                        src={assetUrls.variant(assetId, 'thumb-256')}
                        alt=""
                        className="aspect-square w-full rounded object-cover"
                      />
                      <span className="text-xs">第 {i + 1} 张</span>
                      {on && (
                        <span className="absolute top-2 right-2 text-accent">
                          <Icon name="check" size={14} />
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
              {!role.available.length && (
                <p className="text-xs text-ink-subtle">角色还没有可用参考图</p>
              )}
            </section>
          )
        })}
      </div>
    </Popover>
  )
}
