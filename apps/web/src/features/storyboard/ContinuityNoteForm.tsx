import {
  getCreativeReview,
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
  hasContinuityOpinion,
  isContinuityTag,
  issueLabel,
} from './reviewTags'

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

/** 备注追加后不能超过验收备注的保存上限，超了就提示并不保存，不静默截断。 */
export const CONTINUITY_NOTE_LIMIT = 2000

/** 工作台按当前查看的候选算好的展示模型。 */
export interface ContinuityNoteView {
  /** 可记录的目标：本镜已采用候选（有视频用视频，否则用镜头图） */
  target?: CreativeReviewTarget
  targetReview?: CreativeReview
  /** 当前查看的就是采用候选时表单可写 */
  viewingAdopted: boolean
  /** 查看非采用候选时只读展示其自身意见 */
  viewedTarget?: CreativeReviewTarget
  viewedReview?: CreativeReview
  /** 查看非采用候选而采用候选有衔接意见时的提示 */
  adoptedOpinion?: string
  /** 节点有候选但还没有采用项 */
  needAdopt?: boolean
  /** 查看的是尾帧，但同组关联无法唯一确定所属的视频候选 */
  unmappedTail?: boolean
}

/**
 * 对照区里的紧凑衔接意见：验收只写在已采用候选上，查看其他候选时表单只读。
 * 勾选项表示本次新增的问题维度，已有意见只在摘要里展示。
 * 原有的循环回看与独立观察入口保留为次要按钮。
 */
export function ContinuityNoteForm({
  doc,
  node,
  view,
  writable,
  primary = false,
  canReview = false,
  onReview,
}: {
  doc: PleinDoc
  node?: CanvasElement
  view: ContinuityNoteView
  /** 只读或已离开本镜时禁用；保存前会再核对一次 */
  writable(): boolean
  /** 候选区没有主操作时「标记需修改」升为主按钮，全屏保持一个主动作 */
  primary?: boolean
  canReview?: boolean
  onReview?(): void
}) {
  const [picked, setPicked] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const review = view.targetReview
  const opinion = hasContinuityOpinion(review)
  const lines = review ? continuityNoteLines(review.note) : []
  const viewedOpinion = hasContinuityOpinion(view.viewedReview)
  const controlsDisabled = !view.viewingAdopted || !writable()
  const apply = (
    build: (latest: CreativeReview | undefined) => {
      status: CreativeReviewStatus
      tags: string[]
      note: string
    },
  ) => {
    if (!view.target || !node) return
    if (!writable()) {
      setError('当前只读或本镜已切换，意见未保存')
      return
    }
    // 保存前重读最新意见，并集和追加都以它为准，不覆盖协作者的修改
    const next = build(getCreativeReview(doc.get(node.id), view.target))
    if (next.note.length > CONTINUITY_NOTE_LIMIT) {
      setError('备注已接近上限')
      return
    }
    setError(
      recordCreativeReview(doc, node.id, { target: view.target, ...next })
        ? ''
        : '候选已变化，请核对后重新记录',
    )
  }
  return (
    <section aria-label="衔接意见" className="space-y-2 rounded-lg border border-line p-3 text-xs">
      <p className="text-sm font-medium">衔接意见</p>
      {!node ? (
        <p className="text-ink-subtle">本镜还没有候选</p>
      ) : view.needAdopt ? (
        <p className="text-ink-subtle">先采用一个候选再记衔接意见</p>
      ) : !view.viewingAdopted ? (
        <div className="space-y-2">
          {view.unmappedTail ? (
            <p className="text-warning">无法确定这张尾帧属于哪个视频候选</p>
          ) : viewedOpinion && view.viewedReview ? (
            <div className="text-warning">
              <p>{continuityIssueText(view.viewedReview.tags)}</p>
              {continuityNoteLines(view.viewedReview.note).map((line) => (
                <p key={line} className="whitespace-pre-wrap">
                  {line}
                </p>
              ))}
            </div>
          ) : (
            <p className="text-ink-subtle">此候选没有衔接意见</p>
          )}
          <p className="text-ink-subtle">
            衔接意见记在已采用的候选上；要给这个候选记意见，请先采用它
          </p>
          {view.adoptedOpinion && <p className="text-warning">{view.adoptedOpinion}</p>}
        </div>
      ) : (
        opinion && (
          <div className="text-warning">
            <p>{continuityIssueText(review!.tags)}</p>
            {lines.map((line) => (
              <p key={line} className="whitespace-pre-wrap">
                {line}
              </p>
            ))}
          </div>
        )
      )}
      {!node || view.needAdopt ? null : (
        <>
          <fieldset disabled={controlsDisabled} className="flex flex-wrap gap-x-3 gap-y-1">
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
            maxLength={CONTINUITY_NOTE_LIMIT}
            placeholder="哪里接不上，一句话写清"
            value={note}
            disabled={controlsDisabled}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              className={`ui-btn ui-btn-xs ${primary && view.viewingAdopted ? 'ui-btn-primary' : 'ui-btn-secondary'}`}
              disabled={controlsDisabled}
              onClick={() => apply((latest) => markContinuityChanges(latest, picked, note))}
            >
              标记需修改
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-xs"
              disabled={controlsDisabled || !opinion}
              title={opinion ? undefined : '当前候选没有待解决的衔接意见'}
              onClick={() => apply(resolveContinuity)}
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
    </section>
  )
}
