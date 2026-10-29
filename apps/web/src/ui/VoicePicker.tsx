import { noVoice, type VoiceRef } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { useState } from 'react'
import { useVoices, voiceCredentialTag, voiceTraits } from '../features/library/voices'
import { useCatalog } from '../stores/catalog'
import { Select } from './Select'
import { ProviderIcon } from './ProviderIcon'

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
 * 音色选择：平台声明的预置音色和资产库里「我的音色」（复刻或登记的）从下拉里挑，
 * 表里没有的选「自定义」再填平台和音色 ID。
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
  const catalog = useCatalog((s) => s.catalog)
  const presets = voicePresets(catalog)
  const voices = useVoices()
  const mine = (voices.data ?? []).map((v) => {
    const traits = voiceTraits(v)
    const credential = voiceCredentialTag(
      v,
      catalog?.providers.find((p) => p.id === v.provider),
    )
    return {
      provider: v.provider,
      providerTitle: catalog?.providers.find((p) => p.id === v.provider)?.title ?? v.provider,
      id: v.voiceId,
      label: `我的 · ${v.name}${credential ? ` · ${credential}` : ''}${
        traits ? ` · ${traits}` : ''
      }${v.status === 'training' ? '（训练中）' : v.status === 'failed' ? '（复刻失败）' : ''}`,
      disabled: v.status !== 'ready',
    }
  })
  const keyOf = (p: { provider: string; id: string }) => `${p.provider}|${p.id}`
  const key = value.provider || value.voiceId ? `${value.provider}|${value.voiceId}` : ''
  const known = (p: { provider: string; id: string }) => keyOf(p) === key
  // 我的音色和预置音色同 ID 时只列我的那条（有名字）
  const listed = [
    ...mine,
    ...presets
      .filter((p) => !mine.some((m) => keyOf(m) === keyOf(p)))
      .map((p) => ({ ...p, disabled: false })),
  ]
  // 手动选择自定义是本地编辑意图；外部传入的未知音色始终显示可编辑字段。
  const [custom, setCustom] = useState(false)
  const showCustom = custom || (!!key && !listed.some(known))
  const several = new Set(listed.map((p) => p.provider)).size > 1
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
        id={listed.length ? undefined : id}
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
  // 没有预置音色也没有我的音色：只能手填
  const feedback = voices.isError ? (
    <p role="alert" className="text-xs text-danger">
      我的音色读取失败，当前选择已保留。
      <button
        type="button"
        className="ui-btn ui-btn-quiet ui-btn-xs"
        onClick={() => void voices.refetch()}
      >
        重试
      </button>
    </p>
  ) : voices.isPending ? (
    <p role="status" className="ui-help">
      正在读取我的音色…
    </p>
  ) : null
  if (!listed.length)
    return (
      <div className="flex flex-col gap-2">
        {inputs}
        {feedback}
      </div>
    )
  return (
    <div className="flex flex-col gap-2">
      <Select
        id={id}
        aria-label="音色"
        value={showCustom ? CUSTOM : key}
        options={[
          { value: '', label: '平台默认音色' },
          ...listed.map((p) => ({
            value: `${p.provider}|${p.id}`,
            label: several ? `${p.providerTitle} · ${p.label}` : p.label,
            disabled: p.disabled,
            icon: <ProviderIcon provider={p.provider} />,
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
      {showCustom && inputs}
      {feedback}
    </div>
  )
}
