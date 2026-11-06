import { CapabilityError, capabilityFor, need, placeNew, summarize } from '@plein/capabilities'
import { mediaSize } from '@plein/doc'
import { z } from 'zod'
import { ImportError, importSource } from '../files/services'
import { TicketError } from '../files/tickets'
import type { ServerContext } from './tool-registry'

const id = z.string().min(1).max(200)
const serverCapability = capabilityFor<ServerContext>()

const MAX_BASE64_CHARS = Math.ceil(((8 * 1024 * 1024 + 3) * 4) / 3) + 128

const placeShape = z.object({
  near: id.optional().describe('放在这个元素右侧的空位；不填且没给 x/y 时放在画布内容右侧'),
  x: z.number().optional().describe('世界坐标 x（左上角）'),
  y: z.number().optional(),
  parent_id: id.optional().describe('放进这个 Frame（分组）里'),
  name: z.string().max(100).optional().describe('元素名称，默认用文件名'),
})

/** 资产落到画布上：与 create_element 对图片 / 视频 / 音频的处理一致（尺寸按素材比例，位置同一套规则） */
export function placeAsset(
  ctx: ServerContext,
  asset: { id: string; kind: string; name: string; width?: number; height?: number },
  place: z.output<typeof placeShape>,
) {
  if (asset.kind !== 'image' && asset.kind !== 'video' && asset.kind !== 'audio')
    return { reason: `${asset.kind} 类型的文件不能直接放上画布，只入了资产库` }
  const kind = asset.kind
  const size = mediaSize(kind, asset.width, asset.height)
  return ctx.withDoc((doc) => {
    const elId = placeNew(
      doc,
      place,
      { kind, name: place.name ?? asset.name, assetId: asset.id, ...size },
      ctx.viewport?.(),
    )
    return { element_id: elId, element: summarize(doc, need(doc, elId), false) }
  })
}

const files = (ctx: ServerContext) => {
  if (!ctx.env.files) throw new CapabilityError('这个入口没有开放文件导入')
  return ctx.env.files
}

export const importAsset = serverCapability({
  name: 'import_asset',
  title: '导入文件',
  description:
    '把外部文件送进 Plein 资产库，可选直接摆到画布上。source 三选一：base64（文件内容，解码后最多 8 MiB，可带 data: 前缀）；url（http/https 公网地址，内网和本机地址会被拒绝，最多跟随 5 次重定向）；path（本机绝对路径，只在本机模式可用，限用户主目录内，不含隐藏目录与 ~/Library）。更大的文件改用 request_upload 拿上传地址。name、mime 不填时按文件名和响应推断。返回 asset_id；给了 place 时再返回 element_id（图片 / 视频 / 音频才能摆上画布）。拿到 asset_id 后可用于 create_element、update_element 的 asset_id，或做蒙版 / 切分 / 参考图。',
  group: 'media',
  where: 'server',
  effect: 'edit',
  input: z.object({
    source: z.object({
      path: z.string().min(1).max(4096).optional().describe('本机绝对路径（仅本机模式）'),
      url: z.string().min(1).max(4096).optional().describe('http / https 公网地址'),
      base64: z.string().min(1).max(MAX_BASE64_CHARS).optional().describe('文件内容的 base64'),
      name: z.string().max(255).optional().describe('文件名（含扩展名）'),
      mime: z.string().max(100).optional().describe('MIME 类型；不填按扩展名或响应推断'),
    }),
    place: placeShape.optional().describe('给了就同时放到画布上；不给只入资产库'),
  }),
  run: async (ctx, a) => {
    const f = files(ctx)
    let asset
    try {
      asset = await importSource(ctx.env.assets, f, ctx.env.ownerId, a.source)
    } catch (err) {
      if (err instanceof ImportError) throw new CapabilityError(err.message)
      throw err
    }
    const out: Record<string, unknown> = {
      asset_id: asset.id,
      kind: asset.kind,
      mime: asset.mime,
      name: asset.name,
      size: asset.size,
      ...(asset.width && asset.height ? { width: asset.width, height: asset.height } : {}),
    }
    if (!a.place) return out
    const placed = placeAsset(ctx, asset, a.place)
    return { ...out, ...placed }
  },
})

export const requestUpload = serverCapability({
  name: 'request_upload',
  title: '申请上传地址',
  description:
    '大文件（超过 base64 的 8 MiB 上限，或不在本机）先调用它拿一次性上传地址，再用 HTTP PUT（或 POST）把文件内容作为请求体发到返回的 url，例如 curl -T 文件 "<url>"。上传完成后响应 JSON 里的 asset_id 就是资产 id，接着用 create_element 摆上画布（或 import_asset 之外的任何需要 asset_id 的工具）。地址一次有效、约 15 分钟内过期，只能上传不超过 size 字节的文件。需要 name（含扩展名）、mime 和 size（字节数）。',
  group: 'media',
  where: 'server',
  effect: 'edit',
  input: z.object({
    name: z.string().min(1).max(255).describe('文件名，含扩展名'),
    mime: z.string().min(3).max(100).describe('MIME 类型，如 image/png、video/mp4'),
    size: z.number().int().positive().describe('文件大小（字节）'),
  }),
  run: (ctx, a) => {
    const f = files(ctx)
    if (a.size > f.maxUpload)
      throw new CapabilityError(`文件超过上限 ${Math.round(f.maxUpload / 1048576)} MB`)
    try {
      const t = f.tickets.issueUpload({
        ownerId: ctx.env.ownerId,
        name: a.name,
        mime: a.mime,
        maxBytes: a.size,
      })
      return {
        url: t.url,
        method: 'PUT',
        expires: new Date(t.expires).toISOString(),
        max_bytes: a.size,
        usage: `curl -T <文件> "${t.url}"  （一次性；成功后响应里有 asset_id）`,
      }
    } catch (err) {
      if (err instanceof TicketError) throw new CapabilityError(err.message)
      throw err
    }
  },
})

export const fileCapabilities = [importAsset, requestUpload]
