/** 人工创作验收与候选采用分开；不属于生成参数，也不改变下游输入。 */
export type CreativeReviewStatus = 'pending' | 'usable' | 'changes'

export interface CreativeReviewTarget {
  kind: 'image' | 'video' | 'audio'
  assetId: string
  /** 相同素材出现在不同候选时仍分别验收。直接导入的素材没有 resultId。 */
  resultId?: string
}

export interface CreativeReview {
  target: CreativeReviewTarget
  status: CreativeReviewStatus
  tags: string[]
  note: string
  at: number
}

export function isCreativeReview(value: unknown): value is CreativeReview {
  if (!value || typeof value !== 'object') return false
  const r = value as CreativeReview
  return (
    !!r.target &&
    ['image', 'video', 'audio'].includes(r.target.kind) &&
    typeof r.target.assetId === 'string' &&
    !!r.target.assetId &&
    (r.target.resultId === undefined || typeof r.target.resultId === 'string') &&
    ['pending', 'usable', 'changes'].includes(r.status) &&
    Array.isArray(r.tags) &&
    r.tags.every((tag) => typeof tag === 'string') &&
    typeof r.note === 'string' &&
    typeof r.at === 'number' &&
    Number.isFinite(r.at)
  )
}

export const creativeReviewKey = (target: CreativeReviewTarget) =>
  JSON.stringify([target.kind, target.assetId, target.resultId ?? null])

export const sameCreativeReviewTarget = (
  a: CreativeReviewTarget | undefined,
  b: CreativeReviewTarget | undefined,
) => !!a && !!b && creativeReviewKey(a) === creativeReviewKey(b)
