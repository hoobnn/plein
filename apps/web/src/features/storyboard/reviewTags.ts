import type { CreativeReview } from '@plein/doc'

/** 显示标签统一走 issueLabel，未登记的标签原样显示。 */
export const issueLabels: Record<string, string> = {
  character: '角色一致性',
  composition: '构图',
  motion: '动作',
  camera: '运镜',
  speech: '口型 / 台词',
  sound: '声音',
  continuity: '镜头衔接',
  'continuity-costume': '服装',
  'continuity-facing': '朝向',
  'continuity-position': '位置',
  'continuity-lighting': '光线',
  'continuity-action': '动作',
  other: '其他',
}
export const issueLabel = (tag: string) => issueLabels[tag] ?? tag

/** 镜头衔接的五个细分维度，挂在「镜头衔接」标签之下。 */
export const continuitySubTags = [
  'continuity-costume',
  'continuity-facing',
  'continuity-position',
  'continuity-lighting',
  'continuity-action',
] as const

export const isContinuityTag = (tag: string) =>
  tag === 'continuity' || (continuitySubTags as readonly string[]).includes(tag)

/** 只有需修改的验收还挂着衔接标签才算未解决；标了可用就不算衔接待办。 */
export const hasContinuityOpinion = (review: CreativeReview | undefined) =>
  review?.status === 'changes' && review.tags.some(isContinuityTag)

/** 衔接细分项的中文列表，如「服装、光线」；没有细分项时为空串。 */
export const continuityIssueItems = (tags: readonly string[]) =>
  continuitySubTags
    .filter((tag) => tags.includes(tag))
    .map(issueLabel)
    .join('、')

/** 「衔接需修改：服装、光线」；没有细分项时不列出。没有衔接标签返回 undefined。 */
export function continuityIssueText(tags: readonly string[]): string | undefined {
  if (!tags.some(isContinuityTag)) return undefined
  const items = continuityIssueItems(tags)
  return `衔接需修改${items ? `：${items}` : ''}`
}

/** 查看其他候选时提示采用候选的意见，如「已采用候选有衔接意见：服装、光线」。 */
export function adoptedContinuityText(review: CreativeReview | undefined): string | undefined {
  if (!hasContinuityOpinion(review)) return undefined
  const items = continuityIssueItems(review!.tags)
  return `已采用候选有衔接意见${items ? `：${items}` : ''}`
}
