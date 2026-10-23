import { motionAssetSources } from './sources'
import { Hono } from 'hono'
import { z } from 'zod'
import { connect, createElement } from '@plein/doc'
import { nodeElementOf } from '@plein/capabilities'
import { motionNode, MotionParams, MOTION_TEMPLATE_VERSION } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { AuthEnv } from '../auth'
import type { AssetStore } from '../assets/store'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'
import { ownsCanvas } from '../storage/canvases'
import type { MotionPreviews } from './preview'
import { HYPERFRAMES_VERSION } from './runtime'

const assetId = z.string().regex(/^[0-9a-f]{64}$/)
const Inputs = z.object({ image: assetId.optional(), video: assetId.optional() }).strict()
const PreviewRequest = z.object({ params: MotionParams, inputs: Inputs.default({}) }).strict()
const SourceManifest = z.object({
  schema: z.literal('plein.motion-source.v1'),
  templateVersion: z.literal(MOTION_TEMPLATE_VERSION),
  engine: z.object({ name: z.literal('hyperframes'), version: z.literal(HYPERFRAMES_VERSION) }),
  params: MotionParams,
  inputs: z.record(z.string(), z.object({ assetId, mime: z.string() })).default({}),
})

export function motionRoutes(deps: {
  assets: AssetStore
  previews: MotionPreviews
  db: DB
  rooms: Rooms
}) {
  async function source(owner: string, id: string) {
    if (!assetId.safeParse(id).success) throw new Error('来源不存在')
    const asset = deps.assets.get(owner, id)
    if (!asset || asset.size > 1024 * 1024 || asset.mime !== 'application/json')
      throw new Error('来源不存在')
    const manifest = SourceManifest.parse(
      JSON.parse(new TextDecoder().decode(await deps.assets.readOriginal(owner, id))),
    )
    const inputs: { image?: string; video?: string } = {}
    for (const kind of ['image', 'video'] as const) {
      const binding = manifest.inputs[kind]
      if (!binding) continue
      const media = deps.assets.get(owner, binding.assetId)
      if (!media || media.kind !== kind) throw new Error('原版素材缺失')
      await deps.assets.verifyOriginal(owner, media.id)
      inputs[kind] = media.id
    }
    return { params: manifest.params, inputs, engine: manifest.engine }
  }
  return new Hono<AuthEnv>()
    .get('/api/motion/asset/:id/sources', async (c) => {
      const id = c.req.param('id')
      if (!assetId.safeParse(id).success || !deps.assets.get(c.var.principal.id, id))
        return c.json({ error: 'not_found', message: '素材不存在' }, 404)
      try {
        return c.json({ sources: await motionAssetSources(deps, c.var.principal.id, id) })
      } catch {
        return c.json(
          { error: 'invalid_source', message: '动态合成来源或依赖缺失，无法保留可编辑版本' },
          422,
        )
      }
    })
    .post('/api/motion/preview', async (c) => {
      const parsed = PreviewRequest.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success)
        return c.json({ error: 'invalid', message: '动态合成预览参数不合法' }, 400)
      try {
        const parentOrigin = new URL(c.req.header('origin') ?? c.req.url).origin
        const info = await deps.previews.open(
          c.var.principal.id,
          parsed.data.params,
          parsed.data.inputs,
          parentOrigin,
        )
        return c.json(info, 201)
      } catch (error) {
        return c.json({ error: 'invalid', message: (error as Error).message }, 422)
      }
    })
    .delete('/api/motion/preview/:id', (c) => {
      deps.previews.release(c.var.principal.id, c.req.param('id'))
      return c.body(null, 204)
    })
    .get('/api/motion/source/:id', async (c) => {
      try {
        return c.json(await source(c.var.principal.id, c.req.param('id')))
      } catch {
        return c.json({ error: 'not_found', message: '源工程不存在、版本不兼容或素材缺失' }, 404)
      }
    })
    .post('/api/motion/source/:id/restore', async (c) => {
      if (c.var.principal.role === 'viewer')
        return c.json({ error: 'forbidden', message: '只读成员不能恢复源工程' }, 403)
      const body = z
        .object({ canvasId: z.string().min(1) })
        .safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'invalid', message: '请指定恢复画布' }, 400)
      const owner = c.var.principal.id
      if (!ownsCanvas(deps.db, owner, body.data.canvasId))
        return c.json({ error: 'not_found', message: '画布不存在' }, 404)
      try {
        const original = await source(owner, c.req.param('id'))
        const nodeId = deps.rooms.withDoc(body.data.canvasId, (doc) => {
          if (doc.readOnly) throw new Error('画布只读')
          let id = ''
          doc.ydoc.transact(() => {
            id = createElement(doc, {
              ...nodeElementOf(describeNode(motionNode, 'plein/core'), original.params),
              x: 400,
              y: 100,
              name: `${original.params.title || '动态合成'} · 源版本`,
            })
            for (const [index, kind] of (['image', 'video'] as const).entries()) {
              const media = original.inputs[kind]
              if (!media) continue
              const input = createElement(doc, {
                kind,
                assetId: media,
                x: 40,
                y: 100 + index * 240,
                w: 280,
                h: 180,
              })
              if (!connect(doc, [input, kind], [id, kind])) throw new Error('无法恢复素材连线')
            }
          }, doc.origin)
          return id
        })
        return c.json({ nodeId }, 201)
      } catch {
        return c.json({ error: 'invalid', message: '源工程无法恢复，请检查版本和素材' }, 422)
      }
    })
}
