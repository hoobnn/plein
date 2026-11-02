import type { AnimaticShot } from '@plein/nodes'
import { RequiredSecondsField } from './fields/RequiredSecondsField'

export function AnimaticSettings({
  shot,
  index,
  count,
  onMove,
  onChange,
}: {
  shot: AnimaticShot
  index: number
  count: number
  onMove(to: number): void
  onChange(patch: Partial<AnimaticShot>): void
}) {
  return (
    <div className="space-y-4">
      <p className="ui-help">
        样片镜头 {index + 1} · {shot.dialogue.length} 句已有配音
      </p>
      {(
        [
          ['duration', '样片镜头时长（秒）', 0.2, 300],
          ['lineDelay', '对白起始延迟（秒）', 0, 30],
          ['lineGap', '对白句间停顿（秒）', 0, 10],
        ] as const
      ).map(([key, label, min, max]) => (
        <RequiredSecondsField
          key={key}
          label={label}
          value={shot[key]}
          min={min}
          max={max}
          onChange={(value) => onChange({ [key]: value })}
        />
      ))}
      <p className="ui-help">超出镜头时长的对白会按镜头边界裁切，请在预览中检查节奏。</p>
      <div className="flex gap-2">
        <button
          type="button"
          className="ui-btn ui-btn-quiet"
          disabled={index === 0}
          onClick={() => onMove(index - 1)}
        >
          前移
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-quiet"
          disabled={index === count - 1}
          onClick={() => onMove(index + 1)}
        >
          后移
        </button>
      </div>
    </div>
  )
}
