import { creativeReviewTarget, recordCreativeReview } from '@plein/doc'
import { z } from 'zod'
import { CapabilityError, defineCapability } from './define'
import { need } from './place'

export const reviewCandidate = defineCapability({
  name: 'review_candidate',
  title: '记录候选审片意见',
  group: 'edit',
  where: 'doc',
  effect: 'edit',
  description:
    '给当前采用的图片、视频或音频记录审片状态、标签及意见；独立于候选采用，不改变下游输入。必须带审看片刻的 asset_id，节点还须带 result_id，候选变化则拒绝。这是一条审片意见，不代替用户的内容确认或交付批准。',
  input: z.object({
    id: z.string().min(1),
    asset_id: z.string().min(1),
    result_id: z.string().min(1).optional(),
    status: z.enum(['pending', 'usable', 'changes']),
    tags: z.array(z.string().max(80)).max(8).default([]),
    note: z.string().max(2000).default(''),
  }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const el = need(doc, a.id)
      if (el.locked) throw new CapabilityError('元素已锁定')
      const port = a.result_id ? el.results?.find((r) => r.id === a.result_id)?.port : undefined
      const target = creativeReviewTarget(el, port)
      if (!target || target.assetId !== a.asset_id || target.resultId !== a.result_id)
        throw new CapabilityError('审片目标已变化，请重新读取候选')
      if (
        !recordCreativeReview(doc, a.id, { target, status: a.status, tags: a.tags, note: a.note })
      )
        throw new CapabilityError('无法保存审片意见')
      return { id: a.id, target, status: a.status }
    }),
})
export const reviewCapabilities = [reviewCandidate]
