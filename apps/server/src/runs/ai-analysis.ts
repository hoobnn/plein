import {
  AI_SCENE_TYPE,
  AI_ANALYSIS_LIMITS,
  AiSceneRequest,
  AiSummaryRequest,
  isAiAnalysisType,
  SHOT_ANALYSIS_TYPE,
  ShotAnalysisManifest,
  AiSceneResult,
} from '@plein/nodes'
import { createHash } from 'node:crypto'
import type { PleinDoc } from '@plein/doc'
import { stableStringify } from '@plein/flow'
import { parseModelRef, providerConfigured } from '@plein/plugin-sdk'
import type { PluginHost } from '../plugins/host'

export function aiAnalysisUnit(
  type: string,
  params: Record<string, unknown> | undefined,
): string | undefined {
  const parsed = (type === AI_SCENE_TYPE ? AiSceneRequest : AiSummaryRequest).safeParse(
    params?.request,
  )
  if (!parsed.success) return undefined
  return 'scope' in parsed.data
    ? JSON.stringify([
        parsed.data.scope.origin.canvasId,
        parsed.data.scope.origin.nodeId,
        parsed.data.scope.origin.resultId,
        parsed.data.scope.scene.id,
      ])
    : JSON.stringify(
        parsed.data.drafts
          .map((draft) => [draft.origin.canvasId, draft.origin.nodeId, draft.origin.resultId])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      )
}

/** Pure preflight; no asset bytes, provider call, or model default selection. */
export function aiAnalysisProblem(
  host: PluginHost,
  ownerId: string,
  type: string,
  params: Record<string, unknown>,
  doc: PleinDoc,
  canvasId?: string,
) {
  if (!isAiAnalysisType(type)) return undefined
  const parsed = (type === AI_SCENE_TYPE ? AiSceneRequest : AiSummaryRequest).safeParse(
    params.request,
  )
  if (!parsed.success) return '请从本地拉片清单建立有界分析请求，或重新准备分析版本'
  if ('scope' in parsed.data) {
    const scope = parsed.data.scope
    const local = doc.get(scope.origin.nodeId)
    const result = local?.results?.find(
      (result) => result.id === scope.origin.resultId && result.port === 'analysis',
    )
    const report = ShotAnalysisManifest.safeParse(
      local?.nodeType === SHOT_ANALYSIS_TYPE && result?.value.type === 'json'
        ? result.value.value
        : undefined,
    )
    if (!canvasId || scope.origin.canvasId !== canvasId || !report.success)
      return '本地来源候选缺失或属于历史画布，请从当前拉片清单重新建立分析版本'
    const manifest = report.data
    const scene = manifest.scenes.find((scene) => scene.id === scope.scene.id)
    const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
    if (
      scope.origin.digest !== digest ||
      !scene ||
      stableStringify({
        source: scope.source,
        duration: scope.duration,
        firstVideoPts: scope.firstVideoPts,
        totalScenes: scope.totalScenes,
        timeBasis: scope.timeBasis,
        scene: scope.scene,
      }) !==
        stableStringify({
          source: manifest.source,
          duration: manifest.duration,
          firstVideoPts: manifest.firstVideoPts,
          totalScenes: manifest.scenes.length,
          timeBasis: manifest.timeBasis,
          scene: { id: scene.id, start: scene.start, end: scene.end, frame: scene.frame },
        })
    )
      return '固定采样与真实本地候选不一致，请重新建立分析版本'
  } else {
    for (const draft of parsed.data.drafts) {
      const node = doc.get(draft.origin.nodeId)
      const result = node?.results?.find(
        (result) => result.id === draft.origin.resultId && result.port === 'draft',
      )
      const actual = AiSceneResult.safeParse(
        node?.nodeType === AI_SCENE_TYPE && result?.value.type === 'json'
          ? result.value.value
          : undefined,
      )
      if (
        !canvasId ||
        draft.origin.canvasId !== canvasId ||
        !actual.success ||
        stableStringify(actual.data) !== stableStringify(draft.value)
      )
        return '所选逐镜候选缺失或文字已变化，请重新选择真实候选并预检'
    }
  }
  if (!params.model || params.model !== parsed.data.modelRef)
    return '模型与固定请求不一致，请重新准备分析版本'
  const ref = parseModelRef(parsed.data.modelRef)
  const entry = ref && host.registry.providers.get(ref.provider)
  const model =
    entry &&
    entry.def.models.find(
      (model) => model.id === ref!.model && model.capabilities.includes('text.chat'),
    )
  const config = entry && host.configs.get(ref!.provider)
  if (!entry || !model || !config?.enabled || !providerConfigured(entry.def, config.secrets))
    return '请选择已启用且已配置的模型'
  if (type === AI_SCENE_TYPE && !model.features?.includes('vision'))
    return '逐镜分析需要声明支持 vision 的模型'
  const scopes =
    'scope' in parsed.data
      ? [parsed.data.scope]
      : parsed.data.drafts.map((d) => d.value.request.scope)
  for (const scope of scopes) {
    const source = host.assetInfo(ownerId, scope.source.assetId)
    const frame = host.assetInfo(ownerId, scope.scene.frame.assetId)
    if (
      source?.kind !== 'video' ||
      frame?.kind !== 'image' ||
      frame.mime !== 'image/jpeg' ||
      !frame.width ||
      !frame.height ||
      Math.max(frame.width, frame.height) > 4096 ||
      frame.size > AI_ANALYSIS_LIMITS.frameBytes
    )
      return '来源视频或采样帧缺失，或采样帧不是已解码且最长边不超过 4096、8 MiB 以内的 JPEG'
  }
  return undefined
}
