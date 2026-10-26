import { randomUUID } from 'node:crypto'
import { CapabilityError, capabilityFor, need } from '@plein/capabilities'
import { addResults, currentResult, fitAspect, setParam } from '@plein/doc'
import {
  aspectRatio,
  sampleStageScene,
  stageSceneOf,
  stageSnapshotsOf,
  STAGE_RENDER_VERSION,
  STAGE_TYPE,
} from '@plein/nodes'
import { z } from 'zod'
import type { ServerContext } from './tools'

/** 浏览器只渲染并上传文件，结果由服务端在当前执行身份下写入。 */
export async function renderStage(ctx: ServerContext, scene: unknown): Promise<string> {
  const awareness = ctx.env.rooms.get(ctx.env.canvasId).awareness
  const client = [...awareness.getStates().entries()]
    .filter(([, s]) => s.canvasRenderer === 1 && s.view)
    .sort((a, b) => Number(b[1].view.at) - Number(a[1].view.at))[0]?.[0]
  if (client === undefined)
    throw new CapabilityError('需要在浏览器或桌面端打开当前画布，才能执行 WebGL 构图截图')
  const requestId = randomUUID()
  const signal = ctx.env.execution?.abort.signal
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      awareness.off('change', check)
      signal?.removeEventListener('abort', abort)
      const requests = { ...awareness.getLocalState()?.canvasRenderRequests }
      delete requests[requestId]
      const state = { ...awareness.getLocalState(), canvasRenderRequests: requests }
      awareness.setLocalState(Object.keys(requests).length ? state : null)
    }
    const abort = () => {
      cleanup()
      reject(new CapabilityError('截图已取消'))
    }
    const check = () => {
      const response = awareness.getStates().get(client)?.canvasRenderResults?.[requestId]
      if (!response) return
      cleanup()
      if (response.error) reject(new CapabilityError(String(response.error)))
      else if (
        typeof response.assetId === 'string' &&
        ctx.env.assets.get(ctx.env.ownerId, response.assetId)?.kind === 'image'
      )
        resolve(response.assetId)
      else reject(new CapabilityError('构图截图未返回有效图片资产'))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new CapabilityError('构图截图超时，请确认当前画布仍然打开'))
    }, 40_000)
    awareness.on('change', check)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) return abort()
    awareness.setLocalState({
      ...awareness.getLocalState(),
      canvasRenderRequests: {
        ...awareness.getLocalState()?.canvasRenderRequests,
        [requestId]: { client, scene },
      },
    })
  })
}
const cap = capabilityFor<ServerContext>()
export const captureStage = cap({
  name: 'capture_stage',
  title: '截取 3D 构图参考',
  group: 'media',
  where: 'server',
  effect: 'edit',
  description:
    '用当前画布客户端的 WebGL 渲染器按时刻截图，保存为不可变图片候选及完整场景来源。需要浏览器或桌面端打开这块画布；不调用生成平台。场景和关键帧先用 update_element.params 按 plein/stage 的 schema 编辑。',
  input: z.object({ id: z.string().min(1).max(200), time: z.number().min(0).optional() }),
  run: async (ctx, a) => {
    const captured = ctx.withDoc((doc) => {
      const el = need(doc, a.id)
      if (el.nodeType !== STAGE_TYPE || el.locked)
        throw new CapabilityError('需要未锁定的 3D 构图节点')
      const scene = stageSceneOf(el.params)
      if (a.time !== undefined && (!scene.motion || a.time > scene.motion.duration))
        throw new CapabilityError('截图时刻超出预演时长')
      return {
        scene,
        element: doc.elementMaps.get(a.id),
        adopted: el.adopted,
        result: currentResult(el, 'image')?.id,
      }
    })
    const time = captured.scene.motion ? (a.time ?? 0) : undefined
    const assetId = await renderStage(ctx, sampleStageScene(captured.scene, time ?? 0))
    return ctx.withDoc((doc) => {
      const el = need(doc, a.id)
      if (el.nodeType !== STAGE_TYPE || el.locked || doc.elementMaps.get(a.id) !== captured.element)
        throw new CapabilityError('构图节点已变化或锁定，截图资产已保存，未写入画布')
      const at = Date.now(),
        resultId = `res_${randomUUID()}`
      const entry = {
        resultId,
        assetId,
        rev: captured.scene.rev,
        render: STAGE_RENDER_VERSION,
        scene: captured.scene,
        at,
        ...(time === undefined ? {} : { time }),
      }
      const adopt =
        el.adopted === captured.adopted && currentResult(el, 'image')?.id === captured.result
      doc.ydoc.transact(() => {
        addResults(
          doc,
          a.id,
          [
            {
              id: resultId,
              port: 'image',
              value: { type: 'image', assetId, mime: 'image/png' },
              runId: `snap_${randomUUID()}`,
              at,
            },
          ],
          { adopt },
        )
        const retained = new Set(need(doc, a.id).results?.map((r) => r.id))
        setParam(
          doc,
          a.id,
          'snapshots',
          [entry, ...stageSnapshotsOf(el.params)].filter((s) => retained.has(s.resultId)),
        )
        if (adopt) fitAspect(doc, a.id, aspectRatio(captured.scene.aspect))
      }, doc.origin)
      return { result_id: resultId, asset_id: assetId, adopted: adopt, time }
    })
  },
})
