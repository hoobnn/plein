import type { Engine } from '@plein/canvas-core'
import type { CanvasElement } from '@plein/doc'
import {
  findMentions,
  firstPlaceholder,
  mentionProblem,
  matchProfile,
  mentionQuery,
  pickLabel,
  profileOptions,
  SLOT_LABELS,
  slashQuery,
  sortMentionTargets,
} from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { useRef, useState } from 'react'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Presence } from '../../ui/Presence'
import { assetUrls } from '../../api/client'
import { Icon } from '../../ui/icons'
import { mentionTargets, targetImages } from '../../canvas/nodes'

export type PromptPreset = Catalog['prompts'][number]

/** 候选列表最多列几项 */
const MAX_OPTIONS = 8

/**
 * 主提示词：本地草稿保证输入流畅，每次修改立即写入文档（协作端实时可见）；
 * 未聚焦时跟随文档，其他人改了能看到。
 * 输入 @ 弹出画布上的角色、场景和有名字的图片，选中后插入 `@名字`；行首 / 弹出提示词预设。
 */
export function PromptBox({
  ref,
  engine,
  selfId,
  value,
  presets,
  placeholder,
  onChange,
  onPreset,
  large = false,
}: {
  ref: React.RefObject<HTMLTextAreaElement | null>
  engine: Engine
  selfId: string
  value: string
  presets: PromptPreset[]
  placeholder: string
  onChange(v: string): void
  onPreset(p: PromptPreset): void
  large?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const expandedRef = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  // 正在输入的 @ 引用或行首 / 预设
  const [query, setQuery] = useState<{ kind: '@' | '/'; start: number; query: string } | null>(null)
  const [active, setActive] = useState(0)
  const shown = focused ? draft : value
  // 序号顺序要和 findMentions 一致，否则插进去的 #2 运行时指向另一张卡
  const targets = sortMentionTargets(mentionTargets(engine).filter((t) => t.id !== selfId))
  const q = query?.query.toLowerCase() ?? ''
  // 重名时给每张卡一条候选，插进提示词时自带 #序号，写完再改名字也不会串
  const counts = new Map<string, number>()
  for (const t of targets) counts.set(t.name, (counts.get(t.name) ?? 0) + 1)
  const seen = new Map<string, number>()
  // `@林夏/少` ：列出林夏档案里还没写的那几类（时期、服饰、表情、次音色）
  const profileOpts = (() => {
    if (query?.kind !== '@') return []
    const cut = query.query.lastIndexOf('/')
    if (cut < 0) return []
    const head = query.query.slice(0, cut)
    const seg = query.query.slice(cut + 1)
    const owner = targets.find((t, i) => {
      if (!t.profile) return false
      const total = counts.get(t.name) ?? 1
      const nth = targets.slice(0, i + 1).filter((x) => x.name === t.name).length
      const insert = total > 1 ? `${t.name}#${nth}` : t.name
      return head === insert || head.startsWith(`${insert}/`)
    })
    if (!owner?.profile) return []
    const base = head.slice(0, head.indexOf('/') < 0 ? head.length : head.indexOf('/'))
    const written = matchProfile(head.slice(base.length), owner.profile).pick
    return profileOptions(owner.profile, written)
      .filter((o) => o.name.includes(seg))
      .slice(0, MAX_OPTIONS)
      .map((o) => ({
        ...o,
        key: `${o.slot}:${o.period ?? ''}:${o.name}`,
        insert: `${head}/${o.name}`,
      }))
  })()
  const mentionOptions = (query?.kind === '@' && !query.query.includes('/') ? targets : [])
    .filter((t) => t.name.toLowerCase().includes(q))
    .map((t) => {
      const total = counts.get(t.name) ?? 1
      const nth = (seen.get(t.name) ?? 0) + 1
      seen.set(t.name, nth)
      return { ...t, total, nth, insert: total > 1 ? `${t.name}#${nth}` : t.name }
    })
    .slice(0, MAX_OPTIONS)
  const presetOptions =
    query?.kind === '/'
      ? presets
          .filter((p) => p.title.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
          .slice(0, MAX_OPTIONS)
      : []
  const count = mentionOptions.length + presetOptions.length + profileOpts.length
  const mentions = findMentions(shown, targets)

  const detect = (text: string, caret: number) => {
    const slash = presets.length ? slashQuery(text, caret) : null
    if (slash) return { kind: '/' as const, ...slash }
    const at = mentionQuery(text, caret)
    return at && { kind: '@' as const, ...at }
  }
  const update = (text: string, caret: number) => {
    setDraft(text)
    onChange(text)
    setQuery(detect(text, caret))
    setActive(0)
  }
  /** 把正在输入的查询换成 replacement，然后选中 [selStart, selEnd)（相对替换起点） */
  const replaceQuery = (replacement: string, sel: (inserted: string) => [number, number]) => {
    if (!query) return
    const caret = query.start + 1 + query.query.length
    const text = `${shown.slice(0, query.start)}${replacement}${shown.slice(caret)}`
    update(text, -1)
    setQuery(null)
    const [a, b] = sel(replacement).map((n) => query.start + n)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(a!, b!)
    })
  }
  const insert = (name: string) => replaceQuery(`@${name} `, (r) => [r.length, r.length])
  const applyPreset = (p: PromptPreset) => {
    onPreset(p)
    // 选中第一个【占位】，直接打字替换
    replaceQuery(p.template, (r) => {
      const hole = firstPlaceholder(r)
      return hole ? [hole.start, hole.end] : [r.length, r.length]
    })
  }
  const pick = (i: number) => {
    if (query?.kind === '/') applyPreset(presetOptions[i]!)
    else if (profileOpts.length) insert(profileOpts[i]!.insert)
    else insert(mentionOptions[i]!.insert)
  }
  /** 候选项：按下时不让文本框失焦 */
  const option = (key: string, i: number, onClick: () => void, body: React.ReactNode) => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={i === active}
      onPointerDown={(e) => e.preventDefault()}
      onClick={onClick}
      onPointerEnter={() => setActive(i)}
      className="ui-menu-item"
    >
      {body}
    </button>
  )

  return (
    <div className="relative">
      <textarea
        ref={ref}
        aria-label="提示词"
        value={shown}
        placeholder={placeholder}
        rows={3}
        onFocus={() => {
          setDraft(value)
          setFocused(true)
        }}
        onBlur={() => {
          setFocused(false)
          // 让候选项的点击先生效
          setTimeout(() => setQuery(null), 150)
        }}
        onChange={(e) => update(e.target.value, e.target.selectionStart)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (!count) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const d = e.key === 'ArrowDown' ? 1 : -1
            setActive((a) => (a + d + count) % count)
          } else if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
            e.preventDefault()
            pick(active)
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            setQuery(null)
          }
        }}
        className={`field-sizing-content ${large ? 'max-h-[65vh] min-h-80' : 'max-h-60 min-h-24'} w-full resize-none bg-transparent px-4 py-3 text-base text-ink outline-none placeholder:text-ink-subtle`}
      />
      {!large && (
        <button
          type="button"
          aria-label="放大编辑提示词"
          title="放大编辑提示词"
          className="ui-btn ui-btn-quiet absolute top-1 right-1 opacity-60 hover:opacity-100"
          onClick={() => setExpanded(true)}
        >
          <Icon name="expand" size={14} />
        </button>
      )}
      <Presence>
        {expanded && (
          <Modal
            label="编辑提示词"
            top
            isolateKeys
            initialFocus={expandedRef}
            onClose={() => setExpanded(false)}
            className="max-w-5xl"
          >
            <ModalHeader title="编辑提示词" onClose={() => setExpanded(false)} />
            <div className="ui-scrollbar overflow-auto">
              <PromptBox
                ref={expandedRef}
                engine={engine}
                selfId={selfId}
                value={value}
                presets={presets}
                placeholder={placeholder}
                onChange={onChange}
                onPreset={onPreset}
                large
              />
            </div>
          </Modal>
        )}
      </Presence>
      {mentions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2 text-xs text-ink-subtle">
          引用
          {[
            ...new Map(
              mentions.flatMap((m) => [
                [`${m.id ?? `?${m.name}`}:${pickLabel(m.name, m.pick ?? {})}`, m] as const,
              ]),
            ).values(),
          ].map((m) => {
            if (!m.id) {
              // 指不明的引用当场说清，不等到运行才报错
              return (
                <span
                  key={`?${m.name}`}
                  className="inline-flex items-center gap-1 rounded-md bg-warning/10 px-1.5 py-0.5 text-warning"
                >
                  <Icon name="warning" size={12} />
                  {mentionProblem(m)}
                </span>
              )
            }
            const target = engine.doc.get(m.id)
            if (!target) return null
            const label = pickLabel(m.name, m.pick ?? {})
            const warn = m.profileMiss
              ? `「${m.name}」的档案里没有「${m.profileMiss}」`
              : m.profileConflict
            return (
              <span key={`${m.id}:${label}`} className="contents">
                <MentionChip engine={engine} name={label} target={target} />
                {warn && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-warning/10 px-1.5 py-0.5 text-warning">
                    <Icon name="warning" size={12} />
                    {warn}
                  </span>
                )}
              </span>
            )
          })}
        </div>
      )}
      {presetOptions.length > 0 && (
        <div
          role="listbox"
          aria-label="提示词预设"
          className="ui-menu absolute top-full left-3 z-10 mt-1 w-72"
        >
          {presetOptions.map((p, i) =>
            option(
              p.id,
              i,
              () => applyPreset(p),
              <span className="ui-menu-text">
                <span>{p.title}</span>
                {p.description && <span className="ui-menu-desc truncate">{p.description}</span>}
              </span>,
            ),
          )}
        </div>
      )}
      {profileOpts.length > 0 && (
        <div
          role="listbox"
          aria-label="引用角色档案"
          className="ui-menu absolute top-full left-3 z-10 mt-1 w-72"
        >
          {profileOpts.map((o, i) =>
            option(
              o.key,
              i,
              () => insert(o.insert),
              <>
                {o.images[0] ? (
                  <img
                    src={assetUrls.variant(o.images[0], 'thumb-256')}
                    alt=""
                    className="size-6 flex-none rounded-sm object-cover"
                  />
                ) : (
                  <span className="flex size-6 flex-none items-center justify-center rounded-sm bg-surface-3 text-ink-subtle">
                    <Icon name={SLOT_ICONS[o.slot]} size={12} />
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{o.name}</span>
                <span className="text-xs text-ink-subtle">
                  {o.period ? `${o.period} · ` : ''}
                  {SLOT_LABELS[o.slot]}
                </span>
              </>,
            ),
          )}
        </div>
      )}
      {mentionOptions.length > 0 && (
        <div
          role="listbox"
          aria-label="引用资产"
          className="ui-menu absolute top-full left-3 z-10 mt-1 w-64"
        >
          {mentionOptions.map((t, i) =>
            option(
              t.insert,
              i,
              () => insert(t.insert),
              <>
                <Thumb engine={engine} target={engine.doc.get(t.id)!} />
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                {t.total > 1 && <span className="text-xs text-ink-subtle">#{t.nth}</span>}
                <span className="text-xs text-ink-subtle">{targetKind(engine.doc.get(t.id)!)}</span>
              </>,
            ),
          )}
        </div>
      )}
    </div>
  )
}

const SLOT_ICONS = {
  period: 'period',
  outfit: 'outfit',
  expression: 'expression',
  voiceState: 'mic',
} as const

function targetKind(t: CanvasElement) {
  if (t.nodeType === 'plein/character') return '角色'
  if (t.nodeType === 'plein/scene') return '场景'
  return '图片'
}

/** 被引用资产的 24 小图：第一张参考图，没有时是灰底占位 */
function Thumb({ engine, target }: { engine: Engine; target: CanvasElement }) {
  const id = targetImages(engine, target)[0]
  return id ? (
    <img
      src={assetUrls.variant(id, 'thumb-256')}
      alt=""
      className="size-6 flex-none rounded-sm object-cover"
    />
  ) : (
    <span className="size-6 flex-none rounded-sm bg-surface-3" />
  )
}

/** 提示词里的一个引用：点一下定位到画布上的资产 */
function MentionChip({
  engine,
  name,
  target,
}: {
  engine: Engine
  name: string
  target: CanvasElement
}) {
  return (
    <button
      type="button"
      title={`定位到「${name}」`}
      onClick={() => {
        engine.selection.set([target.id])
        engine.zoomToFit([target.id])
      }}
      className="flex h-7 items-center gap-1.5 rounded-md bg-accent-soft pr-2 pl-0.5 text-accent hover:brightness-110"
    >
      <Thumb engine={engine} target={target} />
      {name}
    </button>
  )
}
