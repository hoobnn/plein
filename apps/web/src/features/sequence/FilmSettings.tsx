import { type SequenceParams, sequenceNode, TRANSITIONS } from '@plein/nodes'
import { findNode } from '../../canvas/nodes'
import { useCatalog } from '../../stores/catalog'
import { Select } from '../../ui/Select'
import { ModelPicker } from '../generator/ModelPicker'
import { NumberField } from './fields/NumberField'
import { Field, Section, SegBlock, SwitchRow } from './fields/SettingsFields'
import { Volume } from './fields/Volume'

/** 成片的设置：画面、字幕、转场、混音，对所有镜头生效 */
export function FilmSettings({
  params,
  readParams,
  set,
}: {
  params: SequenceParams
  readParams(): SequenceParams
  set(key: keyof SequenceParams, value: unknown): void
}) {
  const catalog = useCatalog((s) => s.catalog)
  const node = findNode(catalog, sequenceNode.type)
  return (
    <>
      <Section title="画面">
        <Field label="画幅">
          <SegBlock
            label="画幅"
            value={params.aspectRatio}
            options={[
              { value: '9:16', label: '竖屏 9:16' },
              { value: '16:9', label: '横屏 16:9' },
            ]}
            onChange={(v) => set('aspectRatio', v)}
          />
        </Field>
        <Field label="分辨率">
          <SegBlock
            label="分辨率"
            value={params.resolution}
            options={[
              { value: '1080p', label: '1080p' },
              { value: '720p', label: '720p' },
            ]}
            onChange={(v) => set('resolution', v)}
          />
        </Field>
      </Section>
      <Section title="字幕">
        <SwitchRow
          label="开启字幕"
          help="保留字幕文本与时间，供预览、烧录和SRT工程使用"
          checked={params.subtitles}
          onChange={(v) => set('subtitles', v)}
        />
        {params.subtitles && (
          <Field label="字幕渲染">
            <Select
              aria-label="字幕渲染"
              value={params.subtitleRender}
              onChange={(value) => set('subtitleRender', value)}
              options={[
                { value: 'static', label: '静态字幕' },
                { value: 'animated', label: '动画字幕（HyperFrames）' },
                { value: 'none', label: '不烧录（保留SRT）' },
              ]}
            />
          </Field>
        )}
        {params.subtitles && params.subtitleRender === 'animated' && (
          <Field label="字幕动画">
            <Select
              aria-label="字幕动画"
              value={params.subtitleAnimation}
              onChange={(value) => set('subtitleAnimation', value)}
              options={[
                { value: 'fade', label: '淡入淡出' },
                { value: 'pop', label: '弹出' },
              ]}
            />
          </Field>
        )}
        {params.subtitles && (
          <Field label="样式">
            <SegBlock
              label="字幕样式"
              value={params.subtitleStyle}
              options={[
                { value: '常规', label: '常规' },
                { value: '醒目', label: '醒目' },
                { value: '底框', label: '底框' },
              ]}
              onChange={(v) => set('subtitleStyle', v)}
            />
          </Field>
        )}
        <SwitchRow
          label="按语音识别对齐字幕"
          help="先在字幕页显式识别全部对白，检查后再导出；导出不会自动调用识别"
          checked={params.asrTiming}
          disabled={!params.subtitles}
          onChange={(v) => set('asrTiming', v)}
        />
        {params.subtitles && params.asrTiming && node && (
          <Field label="语音识别模型">
            <ModelPicker
              value={params.model}
              node={{ ...node, capability: 'audio.transcribe' }}
              catalog={catalog}
              onChange={(v) => set('model', v)}
            />
          </Field>
        )}
      </Section>
      <Section title="转场">
        <Field label="默认">
          <Select
            aria-label="转场"
            className="ui-input w-full"
            value={params.transition}
            options={TRANSITIONS.map((value) => ({ value }))}
            onChange={(v) => set('transition', v)}
          />
        </Field>
        {params.transition !== '无' && (
          <Field label="时长">
            <NumberField
              label="转场时长（秒）"
              value={params.transitionDuration}
              readValue={() => readParams().transitionDuration}
              max={2}
              unit="秒"
              onChange={(v) => set('transitionDuration', Math.max(0.2, v ?? 0.5))}
            />
          </Field>
        )}
      </Section>
      <Section title="混音">
        <Volume label="原声" value={params.clipVolume} onChange={(v) => set('clipVolume', v)} />
        <Volume
          label="对白"
          value={params.dialogueVolume}
          onChange={(v) => set('dialogueVolume', v)}
        />
        <Volume label="配乐" value={params.musicVolume} onChange={(v) => set('musicVolume', v)} />
        <Volume label="音效" value={params.sfxVolume} onChange={(v) => set('sfxVolume', v)} />
        <SwitchRow
          label="对白时压低配乐"
          help="有台词的地方配乐自动降低约 10 dB"
          checked={params.duck}
          onChange={(v) => set('duck', v)}
        />
        <SwitchRow
          label="响度标准化"
          help="成片统一到 -14 LUFS，只在导出时处理"
          checked={params.loudnorm}
          onChange={(v) => set('loudnorm', v)}
        />
      </Section>
    </>
  )
}
