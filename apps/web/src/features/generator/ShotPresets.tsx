import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, createElement, setParams } from '@plein/doc'
import {
  findMentions,
  NO_SPEED,
  pickShotPresets,
  SHOT_PRESETS_KEY,
  type ShotSpeed,
  shotConflicts,
  shotLinesIntact,
  shotStateOf,
  slotsFor,
} from '@plein/nodes'
import type { ShotSlot } from '@plein/plugin-sdk'
import type { Catalog } from '@plein/protocol'
import { useState } from 'react'
import { findNode, mentionTargets, type NodeInfo, nodeElement } from '../../canvas/nodes'
import { freeSpotRight } from '../../canvas/presets'
import { useCanvas } from '../../stores/canvas'
import { Icon } from '../../ui/icons'
import { Popover } from '../../ui/Popover'
import { Presence } from '../../ui/Presence'
import { Segmented } from '../../ui/Segmented'

const LABELS: Record<ShotSlot, string> = {
  'camera.move': '运镜',
  'camera.shot': '景别',
  'camera.angle': '角度',
  'camera.light': '光影',
  style: '风格',
}

const SPEED_OPTIONS = [
  { value: 'slow', label: '缓慢' },
  { value: 'normal', label: '匀速' },
  { value: 'fast', label: '快速' },
] as const

const HONEST =
  '这些预设只是往提示词里加一两行描述，不是平台的摄影控制参数，模型不一定照做。要真正带上参考图，用 @风格卡。'

/**
 * 镜头与风格条：运镜、景别、角度、光影、风格各一栏单选，拼成提示词末尾的「镜头：…」「风格：…」，
 * 文字可见可改；手改过那一行后芯片显示「已改动」，再选会把新行接到末尾。
 */
export function ShotPresets({
  engine,
  el,
  node,
  catalog,
  promptKey: pk,
}: {
  engine: Engine
  el: CanvasElement
  node: NodeInfo
  catalog: Catalog | null
  promptKey: string
}) {
  const [open, setOpen] = useState<{ slot: ShotSlot; anchor: HTMLElement } | null>(null)
  const capability = node.capability
  const slots = slotsFor(capability)
  if (!slots.length) return null
  const presets = (catalog?.prompts ?? []).filter(
    (p) =>
      p.slot &&
      slots.includes(p.slot) &&
      (!p.appliesTo?.length || (!!capability && p.appliesTo.includes(capability))),
  )
  const prompt = String(el.params?.[pk] ?? '')
  const state = shotStateOf(el.params?.[SHOT_PRESETS_KEY])
  const intact = shotLinesIntact(prompt, state.lines)
  const styleCard = findMentions(prompt, mentionTargets(engine)).some(
    (m) => m.id && engine.doc.get(m.id)?.nodeType === 'plein/style',
  )
  const conflicts = shotConflicts({ prompt, state, capability, styleCard })

  const change = (c: Parameters<typeof pickShotPresets>[0]['change']) => {
    const next = pickShotPresets({ prompt, state, change: c, presets, capability })
    engine.doc.undo.stopCapturing()
    setParams(engine.doc, el.id, { [pk]: next.prompt, [SHOT_PRESETS_KEY]: next.state })
    engine.doc.undo.stopCapturing()
  }
  const saveStyleCard = (title: string, text: string) => {
    const info = findNode(catalog, 'plein/style')
    if (!info) return useCanvas.getState().notify('没有风格卡节点')
    const base = nodeElement(info)
    engine.doc.undo.stopCapturing()
    const spot = freeSpotRight(engine, el.id, base.w, base.h)
    const id = createElement(engine.doc, {
      ...base,
      name: title,
      params: { ...base.params, description: text },
      x: Math.round(spot.x),
      y: Math.round(spot.y),
    })
    engine.doc.undo.stopCapturing()
    setOpen(null)
    useCanvas
      .getState()
      .notify(`存成了风格卡「${title}」：连入参考图后，在提示词里 @${title} 会真正带上参考图`)
    engine.selection.set([id])
  }

  const current = open && presets.filter((p) => p.slot === open.slot)
  const picked = open && state.picks[open.slot]
  const move = state.picks['camera.move']

  return (
    <div className="flex min-w-0 flex-col gap-1.5 px-4" data-testid="shot-presets">
      <details
        className="group/presets"
        onToggle={(e) => {
          if (!e.currentTarget.open) setOpen(null)
        }}
      >
        <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-xs text-ink-subtle hover:text-ink [&::-webkit-details-marker]:hidden">
          <span className="transition-transform group-open/presets:rotate-90">
            <Icon name="chevronRight" size={12} />
          </span>
          镜头与风格
          <span className="ml-auto">
            {Object.values(state.picks).filter(Boolean).length
              ? `${Object.values(state.picks).filter(Boolean).length} 项已选`
              : '可选'}
          </span>
        </summary>
        <div className="flex flex-wrap items-center gap-1 pt-1">
          {slots.map((slot) => {
            const id = state.picks[slot]
            const p = id ? presets.find((x) => x.id === id) : undefined
            const edited = !!p && !intact[slot === 'style' ? 'style' : 'camera']
            const speed =
              slot === 'camera.move' &&
              p &&
              !NO_SPEED.has(p.id) &&
              state.speed &&
              state.speed !== 'normal'
                ? SPEED_OPTIONS.find((o) => o.value === state.speed)?.label
                : ''
            return (
              <button
                key={slot}
                type="button"
                className="ui-chip ui-chip-btn"
                aria-pressed={!!p}
                aria-expanded={open?.slot === slot}
                data-edited={edited || undefined}
                title={edited ? '这一行在提示词里改过了，再选会在末尾另起一行' : undefined}
                onClick={(e) =>
                  setOpen(open?.slot === slot ? null : { slot, anchor: e.currentTarget })
                }
              >
                <span className={p ? 'text-ink-subtle' : undefined}>{LABELS[slot]}</span>
                {p && <span>{`${speed}${p.title}`}</span>}
                {edited && <span className="text-ink-subtle">· 已改动</span>}
                <Icon name="chevronDown" size={12} />
              </button>
            )
          })}
          <span className="ml-auto text-xs text-ink-subtle" title={HONEST}>
            提示词预设 · 效果因模型而异
          </span>
        </div>
      </details>
      {conflicts.map((c) => (
        <p key={c} className="flex items-start gap-1 text-xs text-warning">
          <span className="mt-0.5 shrink-0">
            <Icon name="warning" size={12} />
          </span>
          {c}
        </p>
      ))}
      <Presence>
        {open && current && (
          <Popover
            anchor={open.anchor}
            onClose={() => setOpen(null)}
            label={LABELS[open.slot]}
            width={240}
            placement="below"
          >
            {open.slot === 'camera.move' && (
              <div className="px-2 pt-2 pb-1">
                <Segmented
                  label="速度"
                  options={SPEED_OPTIONS}
                  value={state.speed ?? 'normal'}
                  onChange={(v: ShotSpeed) => change({ speed: v })}
                />
                {move && NO_SPEED.has(move) && (
                  <p className="ui-help mt-1">固定机位和手持不分速度</p>
                )}
              </div>
            )}
            <div className="ui-menu-label">{LABELS[open.slot]}</div>
            {current.map((p) => (
              <button
                key={p.id}
                type="button"
                className="ui-menu-item"
                aria-pressed={picked === p.id}
                onClick={() => {
                  change({ picks: { [open.slot]: picked === p.id ? null : p.id } })
                  setOpen(null)
                }}
              >
                <span className="ui-menu-text">
                  <span>{p.title}</span>
                  <span className="ui-menu-desc">{p.description ?? p.template}</span>
                </span>
                {picked === p.id && <Icon name="check" size={14} />}
              </button>
            ))}
            {picked && (
              <>
                <div className="ui-sep" />
                <button
                  type="button"
                  className="ui-menu-item"
                  onClick={() => {
                    change({ picks: { [open.slot]: null } })
                    setOpen(null)
                  }}
                >
                  不指定{LABELS[open.slot]}
                </button>
              </>
            )}
            {open.slot === 'style' && picked && (
              <button
                type="button"
                className="ui-menu-item"
                onClick={() => {
                  const p = presets.find((x) => x.id === picked)
                  if (p) saveStyleCard(p.title, p.template)
                }}
              >
                <span className="ui-menu-text">
                  <span>存为风格卡</span>
                  <span className="ui-menu-desc">之后连入参考图，用 @ 引用</span>
                </span>
              </button>
            )}
          </Popover>
        )}
      </Presence>
    </div>
  )
}
