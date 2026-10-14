import { noVoice, type VoiceRef } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { useState } from 'react'
import { useCatalog } from '../stores/catalog'
import { Select } from './Select'

/** 已启用平台里配音模型声明的预置音色，同一平台的同一音色只列一次 */
export function voicePresets(catalog: Catalog | null) {
  const out: Array<{ provider: string; providerTitle: string; id: string; label: string }> = []
  const seen = new Set<string>()
  for (const p of catalog?.providers ?? []) {
    if (!p.enabled) continue
    for (const m of p.models) {
      if (!m.capabilities.includes('audio.speech')) continue
      for (const v of m.voices ?? []) {
        const key = `${p.id}|${v.id}`
        if (seen.has(key)) continue
        seen.add(key)
        const traits = [v.gender === 'female' ? '女' : '男', v.age === 'mature' ? '成熟' : '']
        out.push({
          provider: p.id,
          providerTitle: p.title,
          id: v.id,
          label: `${v.title} · ${traits.filter(Boolean).join(' · ')}`,
        })
      }
    }
  }
  return out
}

const CUSTOM = '__custom'

/**
 * 音色选择：平台声明了预置音色时从下拉里挑（显示名字和性别），
 * 复刻 / 设计出来的音色或表里没有的，选「自定义」再填平台和音色 ID。
 * 平台和音色 ID 要配对：音色只能在同一家平台的配音模型里用。
 */
export function VoicePicker({
  id,
  value,
  onChange,
  inputClassName = 'ui-input',
}: {
  id?: string
  value: VoiceRef
  onChange(v: VoiceRef): void
  inputClassName?: string
}) {
  const presets = voicePresets(useCatalog((s) => s.catalog))
  const key = value.voiceId ? `${value.provider}|${value.voiceId}` : ''
  const known = !key || presets.some((p) => `${p.provider}|${p.id}` === key)
  const [custom, setCustom] = useState(!known)
  const several = new Set(presets.map((p) => p.provider)).size > 1
  const inputs = (
    <div className="flex gap-2">
      <input
        className={`${inputClassName} flex-1`}
        aria-label="音色所属平台"
        placeholder="平台，如 doubao/speech"
        value={value.provider}
        onChange={(e) => onChange({ ...value, provider: e.target.value.trim() })}
      />
      <input
        id={presets.length ? undefined : id}
        className={`${inputClassName} flex-1`}
        aria-label="音色 ID"
        placeholder="音色 ID"
        value={value.voiceId}
        onChange={(e) =>
          onChange(
            e.target.value.trim() === '' && !value.provider
              ? noVoice
              : { ...value, voiceId: e.target.value },
          )
        }
      />
    </div>
  )
  // 没有平台声明音色表：只能手填
  if (!presets.length) return inputs
  return (
    <div className="flex flex-col gap-2">
      <Select
        id={id}
        aria-label="音色"
        value={custom ? CUSTOM : key}
        options={[
          { value: '', label: '平台默认音色' },
          ...presets.map((p) => ({
            value: `${p.provider}|${p.id}`,
            label: several ? `${p.providerTitle} · ${p.label}` : p.label,
          })),
          { value: CUSTOM, label: '自定义音色 ID…' },
        ]}
        onChange={(v) => {
          if (v === CUSTOM) return setCustom(true)
          setCustom(false)
          if (!v) return onChange(noVoice)
          const [provider, voiceId] = v.split('|') as [string, string]
          onChange({ provider, voiceId })
        }}
      />
      {custom && inputs}
    </div>
  )
}
