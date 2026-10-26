import { deliveryCheckNode, DeliveryCheckReport } from '@plein/nodes'
import { defineExecutor, ProviderError } from '@plein/plugin-sdk'
import { isProductionGoal, productionGoalSnapshot } from '@plein/doc'

export const deliveryCheckExecutor = defineExecutor(deliveryCheckNode, async (ctx) => {
  const request = ctx.params.request
  if (!request) throw new ProviderError('invalid_input', '请在实际成片的交付界面选择制作目标后检查')
  let goal: unknown
  try {
    goal = JSON.parse(request.goal.snapshot)
  } catch {
    /* rejected below */
  }
  if (!isProductionGoal(goal) || productionGoalSnapshot(goal) !== request.goal.snapshot)
    throw new ProviderError('invalid_input', '制作目标快照无效，请重新选择目标版本')
  if (!ctx.media.checkVideo) throw new ProviderError('unavailable', '当前宿主不支持成片技术检查')
  const report = DeliveryCheckReport.parse(await ctx.media.checkVideo(request.source, request))
  return { report: [{ type: 'json', value: report }] }
})
