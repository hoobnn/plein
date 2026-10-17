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
import { useEffect, useState } from 'react'
import { Select } from '../../ui/Select'

const inputClass =
  'w-full resize-none rounded-md bg-transparent px-2 py-1.5 text-sm outline-none ring-1 ring-transparent hover:ring-line focus:bg-surface-2 focus:ring-accent'

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
  onChange,
}: {
  engine: Engine
  shot: Shot
  onChange(dialogue: ShotDialogue[]): void
}) {
  const lines = normalizeDialogue(shot.id, shot.dialogue)
  const change = (index: number, value: string) => {
    const previous = lines[index]
    if (!value.trim()) {
      onChange(lines.filter((_, i) => i !== index))
      return
    }
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
    onChange([...lines.slice(0, index), ...next, ...lines.slice(index + 1)])
  }
  const move = (i: number, delta: number) => {
    const next = [...lines]
    const j = i + delta
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    onChange(next)
  }
  return (
    <td className="px-1 py-1">
      {(lines.length ? lines : [{ id: 'empty', character: '', line: '' }]).map((line, i) => (
        <div key={line.id} className="mb-2 space-y-1">
          <DialogueInput
            value={line.character ? `${line.character}：${line.line}` : line.line}
            onChange={(value) => change(i, value)}
          />
          {line.character && (
            <AssetBindingSelect
              engine={engine}
              name={line.character}
              binding={line.speaker}
              speaker
              onChange={(speaker) =>
                onChange(lines.map((d, j) => (j === i ? { ...d, speaker } : d)))
              }
            />
          )}
          {lines.length > 0 && (
            <div className="flex gap-1">
              <button
                type="button"
                className="ui-btn ui-btn-xs ui-btn-quiet"
                aria-label={`上移第 ${i + 1} 句`}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                上移
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-xs ui-btn-quiet"
                aria-label={`下移第 ${i + 1} 句`}
                disabled={i === lines.length - 1}
                onClick={() => move(i, 1)}
              >
                下移
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-xs ui-btn-quiet"
                aria-label={`删除第 ${i + 1} 句`}
                onClick={() => onChange(lines.filter((_, j) => i !== j))}
              >
                删除
              </button>
            </div>
          )}
        </div>
      ))}
      <button
        type="button"
        className="ui-btn ui-btn-xs ui-btn-quiet"
        onClick={() => onChange([...lines, { id: newDialogueId(), character: '', line: '' }])}
      >
        添加台词
      </button>
    </td>
  )
}

function DialogueInput({ value, onChange }: { value: string; onChange(value: string): void }) {
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setDraft(value)
  }, [value, focused])
  return (
    <textarea
      aria-label="台词"
      placeholder="角色：台词"
      rows={2}
      className={inputClass}
      value={focused ? draft : value}
      onFocus={() => {
        setDraft(value)
        setFocused(true)
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setFocused(false)
        if (draft !== value) onChange(draft)
      }}
    />
  )
}
