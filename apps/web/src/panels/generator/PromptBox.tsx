import type { Engine } from '@plein/canvas-core'
import type { CanvasElement } from '@plein/doc'
import { findMentions, firstPlaceholder, mentionQuery, slashQuery } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { useState } from 'react'
import { assetUrls } from '../../api/client'
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
}: {
  ref: React.RefObject<HTMLTextAreaElement | null>
  engine: Engine
  selfId: string
  value: string
  presets: PromptPreset[]
  placeholder: string
  onChange(v: string): void
  onPreset(p: PromptPreset): void
}) {
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  // 正在输入的 @ 引用或行首 / 预设
  const [query, setQuery] = useState<{ kind: '@' | '/'; start: number; query: string } | null>(null)
  const [active, setActive] = useState(0)
  const shown = focused ? draft : value
  const targets = mentionTargets(engine)
  targets.forEach((t, name) => {
    if (t.id === selfId) targets.delete(name)
  })
  const q = query?.query.toLowerCase() ?? ''
  const mentionOptions =
    query?.kind === '@'
      ? [...targets].filter(([name]) => name.toLowerCase().includes(q)).slice(0, MAX_OPTIONS)
      : []
  const presetOptions =
    query?.kind === '/'
      ? presets
          .filter((p) => p.title.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
          .slice(0, MAX_OPTIONS)
      : []
  const count = mentionOptions.length + presetOptions.length
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
    else insert(mentionOptions[i]![0])
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
        className="field-sizing-content max-h-60 min-h-24 w-full resize-none bg-transparent px-4 py-3 text-base text-ink outline-none placeholder:text-ink-subtle"
      />
      {mentions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2 text-xs text-ink-subtle">
          引用
          {[...new Map(mentions.map((m) => [m.name, m.target])).entries()].map(([name, t]) => (
            <MentionChip key={name} engine={engine} name={name} target={t} />
          ))}
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
      {mentionOptions.length > 0 && (
        <div
          role="listbox"
          aria-label="引用资产"
          className="ui-menu absolute top-full left-3 z-10 mt-1 w-64"
        >
          {mentionOptions.map(([name, t], i) =>
            option(
              name,
              i,
              () => insert(name),
              <>
                <Thumb engine={engine} target={t} />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <span className="text-xs text-ink-subtle">{targetKind(t)}</span>
              </>,
            ),
          )}
        </div>
      )}
    </div>
  )
}

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
