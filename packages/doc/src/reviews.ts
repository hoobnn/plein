import * as Y from 'yjs'
import { currentResult, primaryResult, ReadOnlyDocError } from './commands'
import type { PleinDoc } from './doc'
import {
  creativeReviewKey,
  isCreativeReview,
  sameCreativeReviewTarget,
  type CreativeReview,
  type CreativeReviewTarget,
} from './review-types'
import type { CanvasElement } from './types'

export function creativeReviewTarget(
  el: CanvasElement | undefined,
  port?: string,
): CreativeReviewTarget | undefined {
  if (!el) return undefined
  if (el.kind === 'image' || el.kind === 'video' || el.kind === 'audio')
    return el.assetId ? { kind: el.kind, assetId: el.assetId } : undefined
  const result = port === undefined ? primaryResult(el) : currentResult(el, port)
  const value = result?.value
  return result &&
    value &&
    (value.type === 'image' || value.type === 'video' || value.type === 'audio')
    ? { kind: value.type, assetId: value.assetId, resultId: result.id }
    : undefined
}

/** 缺省只读当前采用候选的结论；显式给 target 可查看保留的旧版本意见。 */
export function getCreativeReview(
  el: CanvasElement | undefined,
  target = creativeReviewTarget(el),
): CreativeReview | undefined {
  return target ? el?.reviews?.find((r) => sameCreativeReviewTarget(r.target, target)) : undefined
}

/** 调用方传入审看片刻捕获的目标，迟到的操作不能给新候选写上旧结论。 */
export function recordCreativeReview(
  doc: PleinDoc,
  id: string,
  input: Pick<CreativeReview, 'target' | 'status'> & Partial<Pick<CreativeReview, 'tags' | 'note'>>,
): boolean {
  if (doc.readOnly) throw new ReadOnlyDocError()
  const el = doc.get(id)
  const port =
    el?.kind === 'node'
      ? el.results?.find((result) => result.id === input.target.resultId)?.port
      : undefined
  if (!sameCreativeReviewTarget(creativeReviewTarget(el, port), input.target)) return false
  const review: CreativeReview = {
    target: { ...input.target },
    status: input.status,
    tags: [...new Set(input.tags ?? [])]
      .filter((tag) => tag.trim())
      .slice(0, 8)
      .map((tag) => tag.slice(0, 80)),
    note: (input.note ?? '').trim().slice(0, 2000),
    at: Date.now(),
  }
  if (!isCreativeReview(review)) return false
  const existing = getCreativeReview(el, input.target)
  if (
    existing &&
    existing.status === review.status &&
    existing.note === review.note &&
    JSON.stringify(existing.tags) === JSON.stringify(review.tags)
  )
    return true
  doc.undo.stopCapturing()
  doc.ydoc.transact(() => {
    const m = doc.mutable(id)!
    let reviews = m.get('reviews')
    if (!(reviews instanceof Y.Map)) {
      reviews = new Y.Map<CreativeReview>(
        (el?.reviews ?? []).map((r) => [creativeReviewKey(r.target), r]),
      )
      m.set('reviews', reviews)
    }
    ;(reviews as Y.Map<CreativeReview>).set(creativeReviewKey(review.target), review)
  }, doc.origin)
  doc.undo.stopCapturing()
  return true
}
