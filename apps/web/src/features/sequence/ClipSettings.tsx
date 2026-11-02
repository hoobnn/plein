import { clipLines, type SequenceClip, type SequenceParams, TRANSITIONS } from '@plein/nodes'
import { useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '../../ui/icons'
import { Select } from '../../ui/Select'
import { NumberField } from './fields/NumberField'
import { Field, Section } from './fields/SettingsFields'
import { SubtitleField } from './fields/SubtitleField'
import { Volume } from './fields/Volume'
import { SOUND_LABELS } from './SequenceInstanceTools'
import type { Row } from './types'

const seconds = (s: number | undefined) => (s === undefined ? '—' : `${s.toFixed(1)} 秒`)

/** 选中镜头的设置：顺序、入出点、速度、转场、声音、字幕 */
export function ClipSettings({
  row,
  readRow,
  index,
  count,
  full,
  length,
  params,
  dialogue,
  sfx,
  onMove,
  onPatch,
}: {
  row: Row
  readRow(): Row | undefined
  index: number
  count: number
  full: number | undefined
  length: number | undefined
  params: SequenceParams
  dialogue: Array<{ value: string; label: string; caption?: string }>
  sfx: Array<{ value: string; label: string }>
  onMove(to: number): void
  onPatch(p: Partial<SequenceClip>): void
}) {
  const chosen = params.clips.find((c) =>
    row.clipInstanceId ? c.clipInstanceId === row.clipInstanceId : c.source === row.source,
  )
  // 同一镜头里依次播放的几句台词都列出来
  const caption =
    clipLines(row)
      .map((d) => d.caption)
      .filter(Boolean)
      .join(' / ') || undefined
  const trimmed = length !== undefined && full !== undefined && Math.abs(length - full) > 0.01
  // 修剪出错时说清是哪个点，并把它显示在对应输入框下面：
  // 提示在面板底部时用户看不到，等于没说。
  const [trimError, setTrimError] = useState<{ field: 'in' | 'out'; text: string } | null>(null)
  const trimErrorRef = useRef<HTMLParagraphElement | null>(null)
  useLayoutEffect(() => setTrimError(null), [row.clip.assetId])
  // 提示出现在视野外时要滚进来，用户才知道哪里填错了
  useLayoutEffect(() => {
    trimErrorRef.current?.scrollIntoView({ block: 'nearest' })
  }, [trimError])
  const changeIn = (value: number | undefined) => {
    const latest = readRow()
    if (!latest || latest.clip.assetId !== row.clip.assetId) return
    const start = value ?? 0
    if (start >= Math.min(latest.out ?? Infinity, full ?? Infinity)) {
      setTrimError({ field: 'in', text: '入点需要早于出点和素材结尾，已保留原设置' })
      return
    }
    setTrimError(null)
    onPatch({ in: start })
  }
  const changeOut = (value: number | undefined) => {
    const latest = readRow()
    if (!latest || latest.clip.assetId !== row.clip.assetId) return
    if ((value ?? full ?? Infinity) <= latest.in) {
      setTrimError({ field: 'out', text: '出点需要晚于入点，已保留原设置' })
      return
    }
    setTrimError(null)
    onPatch({ out: value })
  }
  return (
    <>
      <div className="seq-clip-head">
        <span className="seq-clip-index">{String(index + 1).padStart(2, '0')}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{row.el?.name ?? `镜头 ${index + 1}`}</div>
          <div className="text-xs text-ink-subtle tabular-nums">
            {row.pending
              ? '还没有生成'
              : trimmed
                ? `用 ${seconds(length)}，原 ${seconds(full)}`
                : `时长 ${seconds(full)}`}
          </div>
        </div>
        <span className="flex flex-none">
          <button
            type="button"
            aria-label="前移"
            title="前移一段"
            className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
            disabled={index === 0}
            onClick={() => onMove(index - 1)}
          >
            <Icon name="chevronLeft" size={14} />
          </button>
          <button
            type="button"
            aria-label="后移"
            title="后移一段"
            className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
            disabled={index === count - 1}
            onClick={() => onMove(index + 1)}
          >
            <Icon name="chevronRight" size={14} />
          </button>
        </span>
      </div>
      {row.pending ? (
        <p className="ui-help">这段镜头还没有生成，生成后可以修剪和配音。</p>
      ) : (
        <>
          <Section title="剪辑">
            <Field label="入点">
              <NumberField
                key={row.clip.assetId}
                label="入点（秒）"
                value={row.in}
                readValue={() => readRow()?.in}
                max={full}
                unit="秒"
                onChange={changeIn}
              />
              {trimError?.field === 'in' && (
                <p ref={trimErrorRef} role="alert" className="mt-1 block text-xs text-danger">
                  {trimError.text}
                </p>
              )}
            </Field>
            <Field label="出点">
              <NumberField
                key={row.clip.assetId}
                label="出点（秒）"
                value={row.out}
                readValue={() => readRow()?.out}
                placeholder={full === undefined ? '结尾' : full.toFixed(1)}
                max={full}
                unit="秒"
                onChange={changeOut}
              />
              {trimError?.field === 'out' && (
                <p ref={trimErrorRef} role="alert" className="mt-1 block text-xs text-danger">
                  {trimError.text}
                </p>
              )}
            </Field>
            <Field label="速度">
              <Select
                aria-label="速度"
                className="ui-input w-full"
                value={String(row.speed)}
                options={SPEEDS.map((v) => ({ value: String(v), label: `${v}×` }))}
                onChange={(v) => onPatch({ speed: Number(v) === 1 ? undefined : Number(v) })}
              />
            </Field>
          </Section>
          {index > 0 && (
            <Section title="转场">
              <Field label="进入">
                <Select
                  aria-label="进入这段的转场"
                  className="ui-input w-full"
                  value={row.transition ?? AUTO}
                  options={[
                    { value: AUTO, label: `跟随成片（${params.transition}）` },
                    ...TRANSITIONS.map((value) => ({ value })),
                  ]}
                  onChange={(v) =>
                    onPatch({
                      transition: v === AUTO ? undefined : (v as SequenceClip['transition']),
                    })
                  }
                />
              </Field>
              {(row.transition ?? params.transition) !== '无' && (
                <Field label="时长">
                  <NumberField
                    label="这段转场时长（秒）"
                    value={row.transitionDuration}
                    readValue={() => readRow()?.transitionDuration}
                    placeholder={String(params.transitionDuration)}
                    max={2}
                    unit="秒"
                    onChange={(v) =>
                      onPatch({
                        transitionDuration: v === undefined ? undefined : Math.max(0.2, v),
                      })
                    }
                  />
                </Field>
              )}
            </Section>
          )}
        </>
      )}
      <Section title="声音">
        {row.clipInstanceId && (
          <Field label="声音路线">
            <Select
              aria-label="本实例声音路线"
              value={row.sound ?? 'legacy'}
              options={[
                ...(row.sound === 'legacy'
                  ? [{ value: 'legacy', label: SOUND_LABELS.legacy }]
                  : []),
                ...(['native', 'voice', 'mix'] as const).map((value) => ({
                  value,
                  label: SOUND_LABELS[value],
                })),
              ]}
              onChange={(v) => onPatch({ sound: v as SequenceClip['sound'] })}
            />
          </Field>
        )}
        {row.sound === 'native' && (
          <p className="ui-help">原生声音路线不自动认领或播放独立对白。</p>
        )}
        {row.sound === 'voice' && <p className="ui-help">原生声已关闭，独立配音须明确绑定。</p>}
        {!row.pending && row.sound !== 'voice' && (
          <Volume
            label="原声"
            aria="本段原声"
            value={row.volume}
            onChange={(v) => onPatch({ volume: v === 1 ? undefined : v })}
          />
        )}
        {dialogue.length > 0 && row.sound !== 'native' && (
          <ChoiceField
            label="对白"
            options={dialogue}
            chosen={chosen?.dialogue}
            current={row.dialogue?.source}
            allowAuto={!row.clipInstanceId || row.sound === 'legacy'}
            onChange={(v) => onPatch({ dialogue: v })}
          />
        )}
        {clipLines(row).length > 0 && (
          <Field label="台词延后">
            <NumberField
              label="台词延后（秒）"
              value={row.lineDelay || undefined}
              readValue={() => readRow()?.lineDelay || undefined}
              placeholder="0"
              max={10}
              unit="秒"
              onChange={(v) => onPatch({ lineDelay: v ? v : undefined })}
            />
          </Field>
        )}
        {sfx.length > 0 && (
          <ChoiceField
            label="音效"
            options={sfx}
            chosen={chosen?.sfx}
            current={row.sfx?.source}
            allowAuto={!row.clipInstanceId || row.sound === 'legacy'}
            onChange={(v) => onPatch({ sfx: v })}
          />
        )}
      </Section>
      {params.subtitles && (
        <Section title="字幕">
          {params.subtitleTrack ? (
            <p className="ui-help">已使用可编辑字幕轨，请切到「字幕」逐句调整文字与时间。</p>
          ) : (
            <SubtitleField
              value={row.subtitle}
              readValue={() => readRow()?.subtitle}
              placeholder={caption ? caption : '这段没有字幕，可以在这里写'}
              onChange={(v) => onPatch({ subtitle: v })}
            />
          )}
        </Section>
      )}
    </>
  )
}

const AUTO = '__auto'
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
const NONE = '__none'

/** 对白 / 音效：自动（按顺序）、不配，或指定某一条 */
function ChoiceField(props: {
  label: string
  options: Array<{ value: string; label: string }>
  /** 参数里记的选择：undefined 自动，'' 不配 */
  chosen: string | undefined
  /** 实际对应到的那条 */
  current: string | undefined
  allowAuto?: boolean
  onChange(v: string | undefined): void
}) {
  const auto = props.options.find((o) => o.value === props.current)
  const value =
    props.chosen === undefined
      ? props.allowAuto === false
        ? NONE
        : AUTO
      : props.chosen === ''
        ? NONE
        : props.chosen
  return (
    <Field label={props.label}>
      <Select
        aria-label={props.label}
        className="ui-input w-full"
        value={value}
        options={[
          ...(props.allowAuto === false
            ? []
            : [{ value: AUTO, label: auto ? `自动（${auto.label}）` : '自动（无）' }]),
          { value: NONE, label: '不配' },
          ...props.options,
        ]}
        onChange={(v) => props.onChange(v === AUTO ? undefined : v === NONE ? '' : v)}
      />
    </Field>
  )
}
