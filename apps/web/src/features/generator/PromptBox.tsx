import type { Engine } from '@plein/canvas-core'
import type { CanvasElement } from '@plein/doc'
import {
  findMentions,
  firstPlaceholder,
  mentionProblem,
  matchProfile,
  mentionQuery,
  pickLabel,
  pickImages,
  profileOptions,
  SLOT_LABELS,
  slashQuery,
  sortMentionTargets,
} from '@plein/nodes'
import type { PreparedInput, Catalog } from '@plein/protocol'
import { useLayoutEffect, useRef, useState } from 'react'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Presence } from '../../ui/Presence'
import { assetUrls } from '../../api/client'
import { Icon } from '../../ui/icons'
import { MentionTextarea } from '../../ui/MentionTextarea'
import { mentionParts } from '../../canvas/mentionText'
import { findNode, mentionTargets, targetImages } from '../../canvas/nodes'
import { useCatalog } from '../../stores/catalog'
import { videoReferenceTokens } from '@plein/plugin-sdk'
import { submittedMedia } from './submittedMedia'
import { MentionPicker, type MentionChoice, type MentionPickerHandle } from './MentionPicker'

export type PromptPreset = Catalog['prompts'][number]

/** 候选列表最多列几项 */
const MAX_OPTIONS = 8

/**
 * 主提示词：本地草稿保证输入流畅，每次修改立即写入文档（协作端实时可见）；
 * 聚焦时也跟随文档更新，避免继续输入时把同伴的正文替换成旧稿。
 * 输入 @ 弹出画布上的角色、场景和有名字的图片，选中后插入 `@名字`；行首 / 弹出提示词预设。
 */
export function PromptBox({
  ref,
  engine,
  selfId,
  prepared,
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
  prepared?: PreparedInput | null
  value: string
  presets: PromptPreset[]
  placeholder: string
  onChange(v: string): void
  onPreset(p: PromptPreset): void
  large?: boolean
}) {
  const picker = useRef<MentionPickerHandle>(null)
  const catalog = useCatalog((s) => s.catalog)
  const [expanded, setExpanded] = useState(false)
  const expandedRef = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState(value)
  const composing = useRef(false)
  const previous = useRef(value)
  const written = useRef<string | null>(null)
  const selection = useRef<{
    value: string
    start: number
    end: number
    direction: 'forward' | 'backward' | 'none'
  } | null>(null)
  // 正在输入的 @ 引用或行首 / 预设
  const [query, setQuery] = useState<{ kind: '@' | '/'; start: number; query: string } | null>(null)
  const [active, setActive] = useState(0)
  // 原生菜单编辑可能发生在窗口失焦期间；始终显示本地草稿，避免旧文档快照写回文本框。
  const shown = draft
  useLayoutEffect(() => {
    if (previous.current === value) return
    previous.current = value
    const local = written.current === value
    written.current = null
    if (local || composing.current) return
    const input = ref.current
    if (input && document.activeElement === input) {
      const [start, end] = remapSelection(
        input.value,
        value,
        input.selectionStart,
        input.selectionEnd,
      )
      selection.current = { value, start, end, direction: input.selectionDirection }
    }
    setDraft(value)
    setQuery(null)
    setActive(0)
  }, [value, ref])
  useLayoutEffect(() => {
    const pending = selection.current
    const input = ref.current
    if (!pending || !input || input.value !== pending.value) return
    selection.current = null
    if (document.activeElement === input)
      input.setSelectionRange(pending.start, pending.end, pending.direction)
  })
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
  const mentionOptions = (query?.kind === '@' && !query.query.includes('/') ? targets : []).map(
    (t) => {
      const total = counts.get(t.name) ?? 1
      const nth = (seen.get(t.name) ?? 0) + 1
      seen.set(t.name, nth)
      return { ...t, total, nth, insert: total > 1 ? `${t.name}#${nth}` : t.name }
    },
  )
  const presetOptions =
    query?.kind === '/'
      ? presets
          .filter((p) => p.title.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
          .slice(0, MAX_OPTIONS)
      : []
  const count = mentionOptions.length + presetOptions.length + profileOpts.length
  const mentions = findMentions(shown, targets)
  const missing = mentionParts(shown, targets).filter((p) => p.missing)
  const connectedIds = new Set<string>()
  const choices: MentionChoice[] = []
  const element = engine.doc.get(selfId)
  if (
    element?.params?.mode === 'reference' &&
    findNode(catalog, element.nodeType)?.capability === 'video.generate'
  ) {
    const tokens = videoReferenceTokens(shown)
    const items = prepared ? submittedMedia(prepared) : []
    for (const item of items) {
      if (item.source) connectedIds.add(item.source)
      const source = item.source ? engine.doc.get(item.source) : undefined
      choices.push({
        key: item.token,
        name: source?.name ?? item.token,
        insert: item.token,
        category: item.type,
        description: `@${item.token}`,
        thumbnail: item.type === 'audio' ? undefined : item.assetId,
        poster: item.type === 'video',
        used:
          tokens.some((t) => t.kind === item.type && t.index === item.index) ||
          mentions.some((m) => m.id === item.source),
      })
    }
  }
  for (const t of mentionOptions) {
    // 搜索由菜单完成；名称的消歧序号仍使用完整画布目标集。
    const target = engine.doc.get(t.id)
    if (!target || connectedIds.has(t.id)) continue
    choices.push({
      key: t.id,
      name: t.total > 1 ? `${t.name} #${t.nth}` : t.name,
      insert: t.insert,
      category: target.kind === 'image' ? 'image' : 'asset',
      description: targetKind(target),
      thumbnail: targetImages(engine, target)[0],
      used: mentions.some((m) => m.id === t.id),
    })
  }

  const detect = (text: string, caret: number) => {
    const slash = presets.length ? slashQuery(text, caret) : null
    if (slash) return { kind: '/' as const, ...slash }
    const at = mentionQuery(text, caret, targets)
    return at && { kind: '@' as const, ...at }
  }
  const update = (text: string, caret: number) => {
    setDraft(text)
    written.current = text
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
    <div className="plein-prompt relative" data-large={large || undefined}>
      <MentionTextarea
        targets={targets}
        onLocate={(id) => {
          if (!engine.doc.has(id)) return
          engine.selection.set([id])
          engine.zoomToFit([id])
        }}
        ref={ref}
        aria-label="提示词"
        value={shown}
        placeholder={placeholder}
        rows={3}
        onBlur={() => {
          composing.current = false
          // 素材菜单自己处理外部点击，允许搜索框获得焦点；行内候选按下时已阻止失焦。
          if (query?.kind !== '@' || query.query.includes('/')) setQuery(null)
        }}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={(e) => {
          composing.current = false
          update(e.currentTarget.value, e.currentTarget.selectionStart)
        }}
        onChange={(e) => update(e.target.value, e.target.selectionStart)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (query?.kind === '@' && !query.query.includes('/')) {
            picker.current?.handleKey(e)
            return
          }
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
        className={`plein-prompt-input field-sizing-content ${large ? 'max-h-[65vh] min-h-80' : 'max-h-48 min-h-24'} w-full resize-none bg-transparent px-4 py-3 text-base text-ink outline-none placeholder:text-ink-subtle`}
      />
      {!large && (
        <button
          type="button"
          aria-label="放大编辑提示词"
          title="放大编辑提示词"
          className="plein-prompt-expand ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn absolute top-2 right-4"
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
                prepared={prepared}
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
      {(mentions.length > 0 || missing.length > 0) && (
        <div className="flex items-start gap-2 px-4 pb-2 text-xs text-ink-subtle">
          <span className="shrink-0 pt-1 whitespace-nowrap">引用</span>
          <div className="ui-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-1">
            {[...new Map(missing.map((p) => [p.text, p])).values()].map((part) => (
              <span
                key={part.text}
                title={part.warning}
                className="inline-flex items-center gap-1 text-warning"
              >
                <Icon name="warning" size={12} />
                未找到：{part.text}
              </span>
            ))}
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
              const label = pickLabel(m.total > 1 ? `${m.name}#${m.index}` : m.name, m.pick ?? {})
              const warn = m.profileMiss
                ? `「${m.name}」的档案里没有「${m.profileMiss}」`
                : m.profileConflict
              return (
                <span key={`${m.id}:${label}`} className="contents">
                  <MentionChip
                    engine={engine}
                    name={label}
                    target={target}
                    imageId={pickImages(m.pick ?? {}, targetImages(engine, target))[0]}
                  />
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
      {query?.kind === '@' && !query.query.includes('/') && ref.current && (
        <MentionPicker
          key={query.start}
          ref={picker}
          anchor={ref.current}
          query={query.query}
          choices={choices}
          onPick={insert}
          onClose={() => setQuery(null)}
        />
      )}
    </div>
  )
}

/** 按共同前后缀保留光标与选区的位置；参数文本仍沿用文档的整字段更新规则。 */
function remapSelection(
  before: string,
  after: string,
  start: number,
  end: number,
): [number, number] {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix++
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  )
    suffix++
  const oldEnd = before.length - suffix
  const newEnd = after.length - suffix
  const map = (at: number) =>
    at < prefix ? at : at >= oldEnd ? at + after.length - before.length : Math.min(at, newEnd)
  return [map(start), map(end)]
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
  if (t.nodeType === 'plein/prop') return '道具'
  if (t.nodeType === 'plein/style') return '风格'
  if (t.nodeType === 'plein/effect') return '特效'
  return '图片'
}

/** 被引用资产的 24 小图：第一张参考图，没有时是灰底占位 */
function Thumb({
  engine,
  target,
  imageId,
}: {
  engine: Engine
  target: CanvasElement
  imageId?: string
}) {
  const id = imageId ?? targetImages(engine, target)[0]
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
  imageId,
}: {
  engine: Engine
  name: string
  target: CanvasElement
  imageId?: string
}) {
  return (
    <button
      type="button"
      title={`定位到「${name}」`}
      onClick={() => {
        engine.selection.set([target.id])
        engine.zoomToFit([target.id])
      }}
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-surface-2 pr-2 pl-0.5 text-ink-muted hover:bg-accent-soft hover:text-accent"
    >
      <Thumb engine={engine} target={target} imageId={imageId} />
      {name}
    </button>
  )
}
