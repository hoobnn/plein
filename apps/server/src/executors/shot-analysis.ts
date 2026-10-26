import { shotAnalysisNode, ShotAnalysisManifest } from '@plein/nodes'
import { defineExecutor, inputAssets, ProviderError } from '@plein/plugin-sdk'

export const shotAnalysisExecutor = defineExecutor(shotAnalysisNode, async (ctx) => {
  const sources = inputAssets(ctx.inputs, 'video')
  if (sources.length !== 1) throw new ProviderError('invalid_input', '拉片需要一段视频')
  const source = sources[0]!
  if (ctx.params.cutPlan && ctx.params.cutPlan.sourceAssetId !== source.assetId)
    throw new ProviderError('invalid_input', '原视频已变化，旧人工切点未使用，请重新检测')
  if (!ctx.media.analyzeVideo) throw new ProviderError('unavailable', '当前宿主不支持本地拉片')
  const manifest = ShotAnalysisManifest.parse(
    await ctx.media.analyzeVideo(source, {
      threshold: ctx.params.threshold,
      minSceneSeconds: ctx.params.minSceneSeconds,
      points: ctx.params.cutPlan?.points,
      clips: ctx.params.clips,
      audio: ctx.params.audio,
    }),
  )
  return { analysis: [{ type: 'json', value: manifest }] }
})
