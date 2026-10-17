import {
  creativeReviewKey,
  creativeReviewTarget,
  getCreativeReview,
  recordCreativeReview,
  type CanvasElement,
  type CreativeReview,
  type CreativeReviewStatus,
  type CreativeReviewTarget,
  type PleinDoc,
} from '@plein/doc'
import { useState } from 'react'

export const reviewLabels: Record<CreativeReviewStatus, string> = {
  pending: '待审',
  usable: '可用',
  changes: '需修改',
}
const issues = [
  ['character', '角色一致性'],
  ['composition', '构图'],
  ['motion', '动作'],
  ['camera', '运镜'],
  ['speech', '口型 / 台词'],
  ['sound', '声音'],
  ['continuity', '镜头衔接'],
  ['other', '其他'],
] as const

/** 采用决定下游使用哪个候选，创作验收只记录人对具体候选的判断。 */
export function CreativeReviewForm({
  doc,
  node,
  stale = false,
  defaultOpen = false,
}: {
  doc: PleinDoc
  node: CanvasElement
  stale?: boolean
  defaultOpen?: boolean
}) {
  const target = creativeReviewTarget(node)
  if (!target) return <p className="text-xs text-ink-subtle">有产物后可记录创作验收</p>
  const review = getCreativeReview(node, target)
  return (
    <ReviewDraft
      key={`${creativeReviewKey(target)}/${review?.at ?? 0}`}
      doc={doc}
      node={node}
      target={target}
      review={review}
      stale={stale}
      defaultOpen={defaultOpen}
    />
  )
}

function ReviewDraft({
  doc,
  node,
  target,
  review,
  stale,
  defaultOpen,
}: {
  doc: PleinDoc
  node: CanvasElement
  target: CreativeReviewTarget
  review?: CreativeReview
  stale: boolean
  defaultOpen: boolean
}) {
  const [note, setNote] = useState(review?.note ?? '')
  const [tags, setTags] = useState(review?.tags ?? [])
  const [error, setError] = useState('')
  const status = review?.status ?? 'pending'
  const older =
    node.reviews?.filter((r) => creativeReviewKey(r.target) !== creativeReviewKey(target)) ?? []
  const save = (next: CreativeReviewStatus) => {
    if (!recordCreativeReview(doc, node.id, { target, status: next, tags, note }))
      setError('采用候选已改变，请重新打开此候选再记录验收')
  }
  return (
    <details
      open={defaultOpen || undefined}
      className="rounded border border-line px-2 py-1.5 text-xs"
      data-review-node={node.id}
    >
      <summary
        className={`cursor-pointer font-medium ${status === 'changes' ? 'text-warning' : status === 'usable' ? 'text-success' : 'text-ink-muted'}`}
      >
        创作验收：{reviewLabels[status]}
        {stale ? ' · 输入已变化' : ''}
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <p className="text-ink-subtle">
          {target.resultId ? `候选 ${target.resultId.slice(-8)}` : '当前素材'} ·
          此结论只针对这份产物，不改变采用项
        </p>
        {stale && (
          <p className="text-warning">输入已变化；以下结论只针对旧候选，请先核对产物与新要求。</p>
        )}
        <fieldset disabled={doc.readOnly} className="flex flex-wrap gap-x-3 gap-y-1">
          <legend className="mb-1 text-ink-muted">问题标签</legend>
          {issues.map(([value, label]) => (
            <label key={value} className="inline-flex items-center gap-1">
              <input
                type="checkbox"
                checked={tags.includes(value)}
                onChange={(e) =>
                  setTags(e.target.checked ? [...tags, value] : tags.filter((tag) => tag !== value))
                }
              />
              {label}
            </label>
          ))}
        </fieldset>
        <textarea
          aria-label={`创作验收备注 · ${node.name ?? node.id}`}
          rows={2}
          maxLength={2000}
          value={note}
          disabled={doc.readOnly}
          onChange={(e) => setNote(e.target.value)}
          placeholder="具体哪里需要调整，或为什么选这一版"
          className="ui-input w-full resize-y"
        />
        <div className="flex flex-wrap gap-1">
          {(['usable', 'changes', 'pending'] as const).map((value) => (
            <button
              type="button"
              key={value}
              disabled={doc.readOnly}
              className={`ui-btn ui-btn-xs ${value === status ? 'ui-btn-primary' : 'ui-btn-secondary'}`}
              onClick={() => save(value)}
            >
              保存为{reviewLabels[value]}
            </button>
          ))}
        </div>
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        {older.length > 0 && (
          <details className="text-ink-subtle">
            <summary className="cursor-pointer">其他候选的验收记录（{older.length}）</summary>
            {older.map((r) => (
              <p className="mt-1 whitespace-pre-wrap" key={creativeReviewKey(r.target)}>
                {r.target.resultId?.slice(-8) ?? r.target.assetId.slice(0, 8)} ·{' '}
                {reviewLabels[r.status]}
                {r.note ? `：${r.note}` : ''}
              </p>
            ))}
          </details>
        )}
      </div>
    </details>
  )
}
