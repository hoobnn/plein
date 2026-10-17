import type { Engine } from '@plein/canvas-core'
import type { CanvasElement } from '@plein/doc'
import { profileEmpty, profileOf, profileSize } from '@plein/nodes'
import { useState } from 'react'
import { saveCardToLibrary } from '../library/canvas'
import { useCanvas } from '../../stores/canvas'
import { useLibrary } from '../library/store'
import { Icon } from '../../ui/icons'
import { thumb } from '../library/LibraryFields'

/**
 * 角色卡的档案摘要：各时期一排小圆图（带这个时期的服饰套数），下面是总数和引用写法。
 * 档案在资产库里编辑：卡片还没存进资产库时先存一次再打开。
 */
export function ProfileSummary({ engine, el }: { engine: Engine; el: CanvasElement }) {
  const [busy, setBusy] = useState(false)
  const profile = profileOf(el.params?.profile)
  const size = profileSize(profile)
  const name = el.name?.trim() || '角色'

  const open = async (tab: 'periods' | 'expressions') => {
    setBusy(true)
    try {
      const lib = useLibrary.getState()
      await lib.load()
      const current = engine.doc.get(el.id) ?? el
      const linked = useLibrary.getState().items.find((i) => i.id === current.params?.libraryId)
      const item =
        linked ??
        (await saveCardToLibrary(engine, current, lib.projectId, useLibrary.getState())).item
      useLibrary.getState().edit(item, tab)
    } catch (err) {
      useCanvas.getState().notify(`打不开角色档案：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="角色档案" className="flex flex-col gap-2 px-4 pt-3">
      <div className="flex items-center gap-2">
        <span className="ui-section-title">角色档案</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void open('periods')}
          className="ui-btn ui-btn-quiet ui-btn-xs ml-auto"
        >
          {profileEmpty(profile) ? '添加时期、服饰、表情' : '编辑档案'}
          <Icon name="chevronRight" size={12} />
        </button>
      </div>
      {profileEmpty(profile) ? (
        <p className="text-xs text-ink-subtle">
          按时期整理样貌、主音色、次音色和服饰，再加一组表情；提示词里写 @{name}/少年/校服 引用。
        </p>
      ) : (
        <>
          {profile.periods.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {profile.periods.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={busy}
                    title={`${p.name}：${p.outfits.length} 套服饰${p.voiceStates.length ? `，${p.voiceStates.length} 个次音色` : ''}`}
                    onClick={() => void open('periods')}
                    className="ui-chip lib-preset pl-0.5"
                  >
                    {p.images[0] ? (
                      <img
                        src={thumb(p.images[0])}
                        alt=""
                        className="size-5 rounded-full object-cover"
                      />
                    ) : (
                      <Icon name="period" size={12} />
                    )}
                    {p.name}
                    {p.outfits.length > 0 && (
                      <span className="text-ink-subtle tabular-nums">{p.outfits.length} 套</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-ink-subtle">
            {[
              size.outfits && `${size.outfits} 套服饰`,
              size.expressions && `${size.expressions} 个表情`,
              size.voiceStates && `${size.voiceStates} 个次音色`,
            ]
              .filter(Boolean)
              .join(' · ')}
            {(size.outfits || size.expressions || size.voiceStates) && ' · '}
            写 @{name}/{profile.periods[0]?.name ?? profile.expressions[0]?.name} 引用
          </p>
        </>
      )}
    </section>
  )
}
