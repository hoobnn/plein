import { resolveShotAsset, shotAssetBinding } from '@plein/capabilities'
import type { Engine } from '@plein/canvas-core'
import {
  mentionName,
  newDialogueId,
  normalizeDialogue,
  type Shot,
  type ShotAssetBinding,
  type ShotDialogue,
} from '@plein/nodes'
import { useEffect, useId, useRef, useState } from 'react'
import { Select } from '../../ui/Select'

const inputClass =
  'w-full resize-none rounded-md bg-transparent px-2 py-1.5 text-sm outline-none ring-1 ring-transparent hover:ring-line focus:bg-surface-2 focus:ring-accent'
const dialogueText = (line: ShotDialogue) =>
  line.character ? `${line.character}：${line.line}` : line.line

export function AssetBindingSelect({
  engine,
  name,
  binding,
  onChange,
  speaker = false,
}: {
  engine: Engine
  name: string
  binding?: ShotAssetBinding
  onChange(binding: ShotAssetBinding | undefined): void
  speaker?: boolean
}) {
  const cards = [...engine.doc.elements()].filter(
    (el) => mentionName(el) && (!speaker || el.nodeType === 'plein/character'),
  )
  const resolved = resolveShotAsset(engine.doc, name, binding)
  const value = binding ? (resolved?.id ?? '__missing') : ''
  const named = cards.filter((el) => mentionName(el) === name)
  return (
    <Select
      aria-label={`${speaker ? '说话人' : '出场资产'}绑定：${name}`}
      className="w-full text-xs"
      value={value}
      options={[
        {
          value: '',
          label:
            named.length === 1
              ? `按名称：${name}`
              : named.length > 1
                ? `「${name}」有重名，请选择`
                : `「${name}」未绑定`,
        },
        ...(value === '__missing'
          ? [{ value: '__missing', label: '原绑定已不可用，请重新选择' }]
          : []),
        ...cards.map((el) => ({ value: el.id, label: `${mentionName(el)} · ${el.id.slice(-6)}` })),
      ]}
      onChange={(id) => {
        if (id !== '__missing') onChange(id ? shotAssetBinding(engine.doc.get(id)!) : undefined)
      }}
    />
  )
}

/** 一句一行编辑，增删和移动不会把相邻台词认成同一个对象。 */
export function DialogueCell({
  engine,
  shot,
  readDialogue,
  onChange,
  compact = false,
}: {
  engine: Engine
  shot: Shot
  readDialogue(): ShotDialogue[]
  onChange(update: (dialogue: ShotDialogue[]) => ShotDialogue[]): void
  compact?: boolean
}) {
  // 本地结构操作会先重绘本组件，父级的文档订阅按帧更新；渲染也读取最新数组。
  const lines = normalizeDialogue(shot.id, readDialogue())
  const rows = useRef(new Map<string, HTMLDivElement>())
  const [focusId, setFocusId] = useState<string | null>(null)
  useEffect(() => {
    if (!focusId) return
    // 目标可能已经被撤销或删除，不把这次请求留给后续重做。
    setFocusId(null)
    const input = rows.current.get(focusId)?.querySelector('textarea')
    input?.focus({ preventScroll: true })
    input?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [focusId])
  const structure = (update: (current: ShotDialogue[]) => ShotDialogue[]) => {
    engine.doc.undo.stopCapturing()
    try {
      onChange(update)
    } finally {
      engine.doc.undo.stopCapturing()
    }
  }
  // 同一帧内其他台词可能已提交、移动或删除，按稳定 id 更新父级传入的最新数组。
  const change = (lineId: string, value: string) =>
    onChange((current) => {
      const found = current.findIndex((line) => line.id === lineId)
      if (found < 0 && lineId !== 'empty') return current
      const index = found < 0 ? current.length : found
      const previous = current[index]
      if (!value.trim()) return current.filter((line) => line.id !== lineId)
      const next = value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s, i) => {
          const match = /^([^：:]{1,40})[：:](.*)$/.exec(s)
          const character = match?.[1]?.trim() ?? ''
          const line = match ? match[2]!.trim() : s
          return {
            id: i === 0 ? (previous?.id ?? newDialogueId()) : newDialogueId(),
            character,
            line,
            ...(i === 0 && previous?.character === character && previous.speaker
              ? { speaker: previous.speaker }
              : {}),
          }
        })
      return [...current.slice(0, index), ...next, ...current.slice(index + 1)]
    })
  const move = (lineId: string, delta: number) => {
    structure((current) => {
      const i = current.findIndex((line) => line.id === lineId)
      const j = i + delta
      if (i < 0 || j < 0 || j >= current.length) return current
      const next = [...current]
      ;[next[i], next[j]] = [next[j]!, next[i]!]
      return next
    })
    setFocusId(lineId)
  }
  const remove = (lineId: string) => {
    const current = readDialogue()
    const i = current.findIndex((line) => line.id === lineId)
    const remaining = current.filter((line) => line.id !== lineId)
    structure((latest) => latest.filter((line) => line.id !== lineId))
    setFocusId((remaining[i] ?? remaining[i - 1])?.id ?? 'empty')
  }
  return (
    <div className={compact ? 'min-w-0' : 'min-w-0 rounded-lg bg-surface-2 p-2'}>
      {(lines.length ? lines : [{ id: 'empty', character: '', line: '' }]).map((line, i) => (
        <div
          key={line.id}
          ref={(node) => {
            if (node) rows.current.set(line.id!, node)
            else rows.current.delete(line.id!)
          }}
          data-dialogue-id={line.id}
          className="mb-2 space-y-1"
        >
          <DialogueInput
            value={dialogueText(line)}
            readValue={() => {
              const current = readDialogue()
              const latest = current.find((d) => d.id === line.id)
              return latest
                ? dialogueText(latest)
                : line.id === 'empty' && !current.length
                  ? ''
                  : undefined
            }}
            onChange={(value) => change(line.id!, value)}
          />
          {!compact && line.character && (
            <AssetBindingSelect
              engine={engine}
              name={line.character}
              binding={line.speaker}
              speaker
              onChange={(speaker) =>
                onChange((current) =>
                  current.map((d) => (d.id === line.id ? { ...d, speaker } : d)),
                )
              }
            />
          )}
          {!compact && lines.length > 0 && (
            <div className="flex gap-1">
              <button
                type="button"
                className="ui-btn ui-btn-xs ui-btn-quiet"
                aria-label={`上移第 ${i + 1} 句`}
                disabled={i === 0}
                onClick={() => move(line.id!, -1)}
              >
                上移
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-xs ui-btn-quiet"
                aria-label={`下移第 ${i + 1} 句`}
                disabled={i === lines.length - 1}
                onClick={() => move(line.id!, 1)}
              >
                下移
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-xs ui-btn-quiet"
                aria-label={`删除第 ${i + 1} 句`}
                onClick={() => remove(line.id!)}
              >
                删除
              </button>
            </div>
          )}
        </div>
      ))}
      {!compact && (
        <button
          type="button"
          className="ui-btn ui-btn-xs ui-btn-quiet"
          onClick={() => {
            const id = newDialogueId()
            structure((current) => [...current, { id, character: '', line: '' }])
            setFocusId(id)
          }}
        >
          添加台词
        </button>
      )}
    </div>
  )
}

function DialogueInput({
  value,
  readValue,
  onChange,
}: {
  value: string
  readValue(): string | undefined
  onChange(value: string): void
}) {
  const [edit, setEdit] = useState({ base: value, draft: value })
  const input = useRef<HTMLTextAreaElement>(null)
  const conflictId = useId()
  useEffect(() => {
    setEdit((prev) =>
      prev.draft === prev.base || prev.draft === value ? { base: value, draft: value } : prev,
    )
  }, [value])
  const { base, draft } = edit
  const dirty = draft !== base
  const conflict = dirty && base !== value && draft !== value
  const reset = () => {
    const latest = readValue()
    if (latest !== undefined) setEdit({ base: latest, draft: latest })
  }
  const commit = () => {
    const latest = readValue()
    if (latest === undefined) return // 同伴已删除这句，不复活旧台词。
    setEdit({ base: draft, draft })
    if (draft !== latest) onChange(draft)
  }
  return (
    <div>
      <textarea
        ref={input}
        aria-label="台词"
        aria-describedby={conflict ? conflictId : undefined}
        placeholder="角色：台词"
        rows={2}
        className={inputClass}
        value={draft}
        onFocus={() => {
          if (!dirty) reset()
        }}
        onChange={(e) =>
          setEdit({ base: dirty ? base : (readValue() ?? value), draft: e.target.value })
        }
        onBlur={() => {
          const latest = readValue()
          if (!dirty) reset()
          else if (latest !== undefined && (base === latest || draft === latest)) commit()
        }}
      />
      {conflict && (
        <div className="mt-2 space-y-2 rounded-md border border-line bg-surface p-2">
          <p id={conflictId} role="status" className="text-xs text-ink-muted">
            台词已在其他位置更新。请选择要使用的内容。
          </p>
          <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs text-ink-muted">
            {value || '（空）'}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              onClick={() => {
                reset()
                input.current?.focus()
              }}
            >
              使用最新台词
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              onClick={() => {
                commit()
                input.current?.focus()
              }}
            >
              保留当前台词
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
