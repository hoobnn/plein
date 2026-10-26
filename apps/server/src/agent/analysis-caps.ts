import {
  analysisManifest,
  capabilityFor,
  CapabilityError,
  convertAiDrafts,
  createScenePlan,
  createSummaryPlan,
  draftReference,
  need,
  placeAnalysisAssets,
} from '@plein/capabilities'
import { createDoc } from '@plein/doc'
import { AiDraftReference } from '@plein/nodes'
import { z } from 'zod'
import { catalogOf } from '../plugins/routes'
import type { ServerContext } from './tools'

const cap = capabilityFor<ServerContext>()
const id = z.string().min(1).max(200)
export const extractAnalysis = cap({
  name: 'extract_analysis_assets',
  title: '提取拉片素材',
  group: 'media',
  where: 'server',
  effect: 'edit',
  description:
    '从指定拉片结果提取选中镜头的关键帧、视频片段或原音轨，与拉片面板共用素材与来源命令。先 get_element_field 读取结果 manifest；提取既有文件，不重新分析或调用模型。',
  input: z.object({
    id,
    result_id: id,
    scene_ids: z.array(id).max(2000),
    kind: z.enum(['frames', 'clips', 'audio']),
  }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const node = need(doc, a.id)
      if (node.locked) throw new CapabilityError('拉片节点已锁定')
      const report = analysisManifest(doc, a.id, a.result_id)
      if (!report) throw new CapabilityError('拉片结果不存在')
      for (const scene of report.manifest.scenes.filter((scene) =>
        a.scene_ids.includes(scene.id),
      )) {
        const asset = a.kind === 'frames' ? scene.frame : scene.clip
        if (a.kind !== 'audio' && asset && !ctx.assetMeta(asset.assetId))
          throw new CapabilityError('拉片素材不存在或不属于当前用户')
      }
      if (
        a.kind === 'audio' &&
        report.manifest.audio &&
        !ctx.assetMeta(report.manifest.audio.assetId)
      )
        throw new CapabilityError('音轨不存在')
      try {
        return { ids: placeAnalysisAssets(doc, a.id, a.result_id, a.scene_ids, a.kind) }
      } catch (error) {
        throw new CapabilityError(error instanceof Error ? error.message : '无法提取素材')
      }
    }),
})
export const planAnalysis = cap({
  name: 'plan_analysis',
  title: '建立模型拉片草稿',
  group: 'story',
  where: 'server',
  effect: 'edit',
  description:
    '与拉片工作台共用模型逐镜草稿、采样归纳和草稿转分镜命令。action=scenes 从拉片结果选择 1–3 个 scene_ids；summary 归纳 drafts；convert 将经过精确原候选校验的 drafts 转为带来源的分镜计划。只建不跑，需生成时另用 run_node。模型推断始终保留为未经人工核实的草稿，不形成观片或原剧情事实。',
  input: z.object({
    action: z.enum(['scenes', 'summary', 'convert']),
    id: id.optional(),
    result_id: id.optional(),
    scene_ids: z.array(id).min(1).max(3).optional(),
    drafts: z.array(AiDraftReference).min(1).max(3).optional(),
    model: z.string().optional(),
    focus: z.string().max(2000).default(''),
  }),
  run: async (ctx, a) => {
    const lease = ctx.env.rooms.acquire(ctx.env.canvasId)
    const doc = createDoc(lease.room.doc, { origin: ctx.env.origin })
    const check = () => {
      ctx.env.execution?.assertOpen()
      return !doc.readOnly
    }
    try {
      check()
      if (a.action === 'scenes') {
        if (!a.id || !a.result_id || !a.scene_ids || !a.model)
          throw new CapabilityError('需要 id、result_id、scene_ids 和 model')
        if (need(doc, a.id).locked) throw new CapabilityError('拉片节点已锁定')
        const element = doc.elementMaps.get(a.id)
        return {
          ids: await createScenePlan(
            doc,
            catalogOf(ctx.env.host),
            ctx.env.canvasId,
            a.id,
            a.result_id,
            a.scene_ids,
            a.model,
            a.focus,
            () => check() && doc.elementMaps.get(a.id!) === element && !need(doc, a.id!).locked,
          ),
        }
      }
      if (!a.drafts) throw new CapabilityError('需要 drafts，先读取具体模型草稿候选')
      for (const draft of a.drafts) {
        if (need(doc, draft.origin.nodeId).locked) throw new CapabilityError('模型草稿节点已锁定')
        if (!draftReference(doc, ctx.env.canvasId, draft.origin.nodeId, draft.origin.resultId))
          throw new CapabilityError('草稿候选不存在')
      }
      if (a.action === 'convert') return convertAiDrafts(doc, ctx.env.canvasId, a.drafts)
      if (!a.model) throw new CapabilityError('需要归纳模型 model')
      return {
        id: createSummaryPlan(
          doc,
          catalogOf(ctx.env.host),
          ctx.env.canvasId,
          a.drafts,
          a.model,
          a.focus,
        ),
      }
    } catch (error) {
      if (error instanceof CapabilityError) throw error
      throw new CapabilityError(error instanceof Error ? error.message : '无法建立分析草稿')
    } finally {
      doc.destroy()
      lease.release()
    }
  },
})
export const analysisCapabilities = [extractAnalysis, planAnalysis]
