import type { Engine } from '@plein/canvas-core'
import { setParam } from '@plein/doc'
import type { PreparedInput } from '@plein/protocol'
import { useState } from 'react'
import { assetUrls } from '../../api/client'
import { Icon } from '../../ui/icons'
import { Popover } from '../../ui/Popover'
import { Presence } from '../../ui/Presence'

/** 显式选择按资产 id 保存，重排角色参考图后也不会换成另一张；空数组表示只带文字。 */
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
  const roles = data?.refs.filter((r) => r.kind === 'character') ?? []
  if (!roles.length) return null
  const read = (): Record<string, string[]> => {
    const value = engine.doc.get(nodeId)?.params?.referenceImagePicks
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, string[]>)
      : {}
  }
  const select = (id: string, images: string[] | undefined) => {
    const picks = { ...read() }
    if (images === undefined) delete picks[id]
    else picks[id] = images
    engine.doc.undo.stopCapturing()
    setParam(engine.doc, nodeId, 'referenceImagePicks', picks)
    engine.doc.undo.stopCapturing()
  }
  const picks = read()
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
      <Presence>
        {anchor && (
          <Popover anchor={anchor} onClose={() => setAnchor(null)} label="角色参考图" width={380}>
            <p className="mb-3 text-xs text-ink-subtle">
              选择某一张会只送这张图；“仅文字”保留角色设定，不自动附图。
            </p>
            <div className="ui-scrollbar flex max-h-80 flex-col gap-4 overflow-y-auto">
              {roles.map((role) => (
                <section key={`${role.elementId}/${role.name}`} aria-label={`${role.name}参考图`}>
                  <h4 className="mb-2 text-sm font-medium">{role.name}</h4>
                  <div className="mb-2 flex gap-2">
                    <button
                      type="button"
                      className="ui-chip ui-chip-btn"
                      aria-pressed={picks[role.elementId] === undefined}
                      onClick={() => select(role.elementId, undefined)}
                    >
                      自动选择
                    </button>
                    <button
                      type="button"
                      className="ui-chip ui-chip-btn"
                      aria-pressed={picks[role.elementId]?.length === 0}
                      onClick={() => select(role.elementId, [])}
                    >
                      仅文字
                    </button>
                  </div>
                  <div
                    role="listbox"
                    aria-label={`${role.name}可用图片`}
                    className="grid grid-cols-4 gap-2"
                  >
                    {role.available.map((assetId, i) => (
                      <button
                        key={assetId}
                        type="button"
                        role="option"
                        aria-label={`选择${role.name}第${i + 1}张参考图`}
                        aria-selected={picks[role.elementId]?.includes(assetId) ?? false}
                        className="relative overflow-hidden rounded-lg border border-line p-1 aria-selected:border-accent aria-selected:bg-accent/10"
                        onClick={() => select(role.elementId, [assetId])}
                      >
                        <img
                          src={assetUrls.variant(assetId, 'thumb-256')}
                          alt=""
                          className="aspect-square w-full rounded object-cover"
                        />
                        <span className="text-xs">第 {i + 1} 张</span>
                        {picks[role.elementId]?.includes(assetId) && (
                          <span className="absolute top-2 right-2 text-accent">
                            <Icon name="check" size={14} />
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  {!role.available.length && (
                    <p className="text-xs text-ink-subtle">角色还没有可用参考图</p>
                  )}
                </section>
              ))}
            </div>
          </Popover>
        )}
      </Presence>
    </>
  )
}
