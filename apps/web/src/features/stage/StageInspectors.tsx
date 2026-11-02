import {
  STAGE_ASPECTS,
  STAGE_BLOCKS,
  STAGE_BOUNDS,
  STAGE_POSES,
  type StageAspect,
  type StageBlock,
  type StageCamera,
  type StageFigure,
  type StageScene,
} from '@plein/nodes'
import { Icon } from '../../ui/icons'
import { Field, NameField, NumberField, Section, Slider } from './StageFields'
import { FIGURE_COLORS, FOCALS, focalHint } from './stage.utils'
import type { StageMode } from './view'

export function FigureInspector(props: {
  figure: StageFigure
  onChange(p: Partial<StageFigure>): void
  onRemove(): void
  onAim(): void
}) {
  const f = props.figure
  return (
    <>
      <Section title="人物">
        <NameField value={f.name} onChange={(name) => props.onChange({ name })} />
        <Field label="颜色">
          <span className="flex gap-1.5">
            {FIGURE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`颜色 ${c}`}
                aria-pressed={f.color === c}
                className="stage-color"
                style={{ background: c }}
                onClick={() => props.onChange({ color: c })}
              />
            ))}
          </span>
        </Field>
        <Slider
          label="身高"
          value={f.height}
          min={0.9}
          max={2.1}
          step={0.01}
          unit=" 米"
          onChange={(height) => props.onChange({ height })}
        />
      </Section>
      <Section title="姿态">
        <div className="stage-poses">
          {STAGE_POSES.map((p) => (
            <button
              key={p.id}
              type="button"
              className="ui-btn ui-btn-sm ui-btn-secondary"
              aria-pressed={f.pose === p.id}
              data-active={f.pose === p.id || undefined}
              onClick={() => props.onChange({ pose: p.id })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <Slider
          label="朝向"
          value={f.facing}
          min={-180}
          max={180}
          step={1}
          unit="°"
          onChange={(facing) => props.onChange({ facing })}
        />
      </Section>
      <Section title="位置">
        <NumberField label="左右" value={f.x} onChange={(x) => props.onChange({ x })} />
        <NumberField label="前后" value={f.z} onChange={(z) => props.onChange({ z })} />
        <div className="flex gap-2">
          <button
            type="button"
            className="ui-btn ui-btn-sm ui-btn-secondary flex-1"
            onClick={props.onAim}
          >
            机位对准
          </button>
          <button type="button" className="ui-btn ui-btn-sm ui-btn-quiet" onClick={props.onRemove}>
            <Icon name="trash" size={14} />
            删除
          </button>
        </div>
      </Section>
    </>
  )
}

export function BlockInspector(props: {
  block: StageBlock
  onChange(p: Partial<StageBlock>): void
  onRemove(): void
}) {
  const b = props.block
  const kind = STAGE_BLOCKS.find((k) => k.id === b.kind)?.label ?? '方块'
  const size = (key: 'w' | 'h' | 'd', label: string, max: number) => (
    <Slider
      label={label}
      value={b[key]}
      min={0.05}
      max={max}
      step={0.05}
      unit=" 米"
      onChange={(v) => props.onChange({ [key]: v })}
    />
  )
  return (
    <>
      <Section title={kind}>
        <NameField value={b.name ?? kind} onChange={(name) => props.onChange({ name })} />
        {size('w', '宽', 12)}
        {size('h', '高', 6)}
        {size('d', '深', 12)}
      </Section>
      <Section title="位置">
        <NumberField label="左右" value={b.x} onChange={(x) => props.onChange({ x })} />
        <NumberField label="前后" value={b.z} onChange={(z) => props.onChange({ z })} />
        <Slider
          label="朝向"
          value={b.facing}
          min={-180}
          max={180}
          step={1}
          unit="°"
          onChange={(facing) => props.onChange({ facing })}
        />
        <button
          type="button"
          className="ui-btn ui-btn-sm ui-btn-quiet self-end"
          onClick={props.onRemove}
        >
          <Icon name="trash" size={14} />
          删除
        </button>
      </Section>
    </>
  )
}

export function CameraInspector(props: {
  scene: StageScene
  mode: StageMode
  onAspect(a: StageAspect): void
  onChange(p: Partial<StageCamera>): void
  onFromView(): void
}) {
  const c = props.scene.camera
  return (
    <>
      <Section title="画幅">
        <div className="stage-aspects">
          {STAGE_ASPECTS.map((a) => (
            <button
              key={a}
              type="button"
              className="ui-btn ui-btn-sm ui-btn-secondary tabular-nums"
              aria-pressed={props.scene.aspect === a}
              data-active={props.scene.aspect === a || undefined}
              onClick={() => props.onAspect(a)}
            >
              {a}
            </button>
          ))}
        </div>
      </Section>
      <Section title="镜头">
        <Slider
          label="焦距"
          value={c.focal}
          min={12}
          max={200}
          step={1}
          unit="mm"
          onChange={(focal) => props.onChange({ focal })}
        />
        <div className="stage-focals">
          {FOCALS.map((f) => (
            <button
              key={f}
              type="button"
              className="stage-link tabular-nums"
              data-active={c.focal === f || undefined}
              onClick={() => props.onChange({ focal: f })}
            >
              {f}
            </button>
          ))}
          <span className="ml-auto text-ink-subtle">{focalHint(c.focal)}</span>
        </div>
        <Slider
          label="机位高"
          value={c.y}
          min={STAGE_BOUNDS.cameraHeight.min}
          max={STAGE_BOUNDS.cameraHeight.max}
          step={0.05}
          unit=" 米"
          onChange={(y) => props.onChange({ y })}
        />
      </Section>
      {props.mode === 'free' && (
        <Section title="从这里拍">
          <p className="ui-help">把机位放到当前自由视角的位置，看向同一个点。</p>
          <button
            type="button"
            className="ui-btn ui-btn-sm ui-btn-secondary"
            onClick={props.onFromView}
          >
            设为机位
          </button>
        </Section>
      )}
      <p className="ui-help">选中人物后可以「机位对准」，再在机位视角里拖动画面微调。</p>
    </>
  )
}
