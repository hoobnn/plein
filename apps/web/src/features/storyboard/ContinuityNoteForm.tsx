import {
  recordCreativeReview,
  type CanvasElement,
  type CreativeReview,
  type CreativeReviewStatus,
  type CreativeReviewTarget,
  type PleinDoc,
} from '@plein/doc'
import { useState } from 'react'
import {
  continuityIssueText,
  continuitySubTags,
  isContinuityTag,
  issueLabel,
} from './CreativeReviewForm'

/** 有任一衔接标签即视为该候选还有未解决的衔接意见。 */
export const hasContinuityOpinion = (review: CreativeReview | undefined) =>
  !!review?.tags.some(isContinuityTag)

/** 标记需修改：状态固定 changes，标签取并集，备注追加一行，不覆盖已有内容。 */
export function markContinuityChanges(
  review: CreativeReview | undefined,
  picked: readonly string[],
  note: string,
): { status: CreativeReviewStatus; tags: string[]; note: string } {
  const remark = note.trim()
  return {
    status: 'changes',
    tags: [...new Set([...(review?.tags ?? []), 'continuity', ...picked])],
    note: remark
      ? `${review?.note ? `${review.note}\n` : ''}衔接：${remark}`
      : (review?.note ?? ''),
  }
}

/** 衔接问题已解决：移除衔接标签；没有其他问题标签且原为 changes 时交还整体审阅，绝不自动判可用。 */
export function resolveContinuity(review: CreativeReview | undefined): {
  status: CreativeReviewStatus
  tags: string[]
  note: string
} {
  const tags = (review?.tags ?? []).filter((tag) => !isContinuityTag(tag))
  return {
    status:
      review?.status === 'changes' && !tags.length ? 'pending' : (review?.status ?? 'pending'),
    tags,
    note: review?.note ?? '',
  }
}

/** 备注里「衔接：」开头的行就是历次衔接意见。 */
export const continuityNoteLines = (note: string) =>
  note.split('\n').filter((line) => line.startsWith('衔接：'))

/**
 * 对照区里的紧凑衔接意见：记在本镜当前查看候选的创作验收上，换候选即视为未审阅。
 * 原有的循环回看与独立观察入口保留为次要按钮。
 */
export function ContinuityNoteForm({
  doc,
  node,
  target,
  review,
  priorOpinion = false,
  writable,
  primary = false,
  canReview = false,
  onReview,
}: {
  doc: PleinDoc
  node?: CanvasElement
  /** 本镜当前查看的候选；没有可审候选时只留说明 */
  target?: CreativeReviewTarget
  review?: CreativeReview
  /** 之前的候选留有衔接意见而当前候选尚未审阅 */
  priorOpinion?: boolean
  /** 只读或已离开本镜时禁用；保存前会再核对一次 */
  writable(): boolean
  /** 候选区没有主操作时「标记需修改」升为主按钮，全屏保持一个主动作 */
  primary?: boolean
  canReview?: boolean
  onReview?(): void
}) {
  const [picked, setPicked] = useState<string[]>(() =>
    (review?.tags ?? []).filter((tag) => (continuitySubTags as readonly string[]).includes(tag)),
  )
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const opinion = hasContinuityOpinion(review)
  const lines = review ? continuityNoteLines(review.note) : []
  const apply = (next: { status: CreativeReviewStatus; tags: string[]; note: string }) => {
    if (!target || !node) return
    if (!writable()) {
      setError('当前只读或本镜已切换，意见未保存')
      return
    }
    setError(
      recordCreativeReview(doc, node.id, { target, ...next }) ? '' : '候选已变化，请核对后重新记录',
    )
  }
  return (
    <div aria-label="衔接意见" className="space-y-2 rounded-lg border border-line p-3 text-xs">
      <p className="text-sm font-medium">衔接意见</p>
      {opinion && review ? (
        <div className="text-warning">
          <p>{continuityIssueText(review.tags)}</p>
          {lines.map((line) => (
            <p key={line} className="whitespace-pre-wrap">
              {line}
            </p>
          ))}
        </div>
      ) : priorOpinion ? (
        <p className="text-warning">之前的候选有衔接意见，当前候选尚未审阅衔接</p>
      ) : null}
      {!target ? (
        <p className="text-ink-subtle">本镜还没有候选</p>
      ) : (
        <>
          <fieldset disabled={!writable()} className="flex flex-wrap gap-x-3 gap-y-1">
            {continuitySubTags.map((tag) => (
              <label key={tag} className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={picked.includes(tag)}
                  onChange={(e) =>
                    setPicked(
                      e.target.checked ? [...picked, tag] : picked.filter((value) => value !== tag),
                    )
                  }
                />
                {issueLabel(tag)}
              </label>
            ))}
          </fieldset>
          <input
            aria-label="衔接意见备注"
            className="ui-input w-full"
            maxLength={2000}
            placeholder="哪里接不上，一句话写清"
            value={note}
            disabled={!writable()}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              className={`ui-btn ui-btn-xs ${primary ? 'ui-btn-primary' : 'ui-btn-secondary'}`}
              disabled={!writable()}
              onClick={() => apply(markContinuityChanges(review, picked, note))}
            >
              标记需修改
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-xs"
              disabled={!writable()}
              onClick={() => apply(resolveContinuity(review))}
            >
              衔接问题已解决
            </button>
          </div>
        </>
      )}
      <button
        type="button"
        className="ui-btn ui-btn-secondary ui-btn-xs"
        disabled={!canReview}
        title={
          canReview
            ? '循环回看切点前后各一秒，记录两镜的独立观察与完整创作验收'
            : '相邻两镜都有已采用的视频后，可循环回看切点并记录观察'
        }
        onClick={onReview}
      >
        回看切点并记录观察
      </button>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
