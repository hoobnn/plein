import type { ProductionGoalRevision } from '@plein/doc'

export const requirementLabels = {
  dialogue: '对白',
  originalAudio: '镜头原声',
  music: '配乐',
  sfx: '音效',
  subtitles: '字幕',
} as const
const valueLabels = { unspecified: '未约定', required: '需要', none: '不需要' }
export function ProductionGoalSummary({ revision }: { revision: ProductionGoalRevision }) {
  const goal = revision.content
  return (
    <div className="flex flex-col gap-1 text-2xs">
      <p className="break-all font-medium" data-testid="production-goal-version">
        目标版本 {revision.id}
      </p>
      <p>
        规格：{goal.aspectRatio ?? '画幅未约定'} · {goal.resolution ?? '分辨率未约定'}
      </p>
      <p>
        目标时长：
        {goal.duration
          ? `${goal.duration.min ?? '不限'} 至 ${goal.duration.max ?? '不限'} 秒`
          : '未约定'}
      </p>
      <p>
        {Object.entries(requirementLabels)
          .map(
            ([key, label]) =>
              `${label}：${valueLabels[goal[key as keyof typeof requirementLabels]]}`,
          )
          .join(' · ')}
      </p>
      {(goal.allowSilence || goal.allowBlack) && (
        <p>
          技术例外：
          {[goal.allowSilence && '允许有意静音', goal.allowBlack && '允许有意黑场']
            .filter(Boolean)
            .join('、')}
          ；仍需核对实际范围。
        </p>
      )}
      <p className="whitespace-pre-wrap break-words">
        文字创作要求：{goal.requirements || '未填写，需人工核对'}
      </p>
      {revision.origin && (
        <p className="break-all text-ink-subtle">
          目标复制自 {revision.origin.scope.canvasId} / {revision.origin.scope.boardId} ·{' '}
          {revision.origin.id}
        </p>
      )}
    </div>
  )
}
