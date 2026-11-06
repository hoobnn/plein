import { createWriteStream } from 'node:fs'
import { constants } from 'node:fs'
import { copyFile, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  CapabilityError,
  capabilityFor,
  content,
  need,
  placeNew,
  summarize,
} from '@plein/capabilities'
import { mediaSize } from '@plein/doc'
import { z } from 'zod'
import { LocalPathError, resolveSaveTarget } from '../files/local-path'
import { type FileServices, ImportError, importSource } from '../files/services'
import { type DownloadTarget, TicketError } from '../files/tickets'
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

const SAVE_TO = z
  .string()
  .min(1)
  .max(4096)
  .optional()
  .describe('可选：同时保存到本机这个绝对路径（只在本机模式可用，限用户主目录内，不覆盖已有文件）')

/** 把资产原件或内部下载路径存到本机目录（受与 import_asset(path) 相同的目录约束） */
async function saveLocal(
  ctx: ServerContext,
  f: FileServices,
  target: DownloadTarget,
  saveTo: string,
): Promise<string> {
  if (!f.local) throw new CapabilityError('save_to 只在本机模式可用；请改用返回的 download_url')
  let path: string
  try {
    path = await resolveSaveTarget(f.local, saveTo)
  } catch (err) {
    if (err instanceof LocalPathError) throw new CapabilityError(err.message)
    throw err
  }
  try {
    if (target.kind === 'asset') {
      if (!ctx.env.assets.get(ctx.env.ownerId, target.assetId))
        throw new CapabilityError(`资产 ${target.assetId} 不存在`)
      await copyFile(ctx.env.assets.originalPath(target.assetId), path, constants.COPYFILE_EXCL)
    } else {
      if (!ctx.env.canvasApi) throw new CapabilityError('扩展画布服务不可用')
      const res = await ctx.env.canvasApi(
        ctx.env.ownerId,
        new Request(`http://plein.internal${target.path}`, {
          signal: ctx.env.execution?.abort.signal,
        }),
      )
      if (!res.ok || !res.body) throw new CapabilityError('导出文件已过期，请重新导出')
      await pipeline(
        Readable.fromWeb(res.body as never),
        createWriteStream(path, { flags: 'wx', mode: 0o600 }),
      )
    }
  } catch (err) {
    await rm(path, { force: true })
    throw err
  }
  return path
}

/**
 * 交付一个文件：签发短期只读下载票据，返回文字（含绝对地址）和 MCP resource_link 内容块；
 * 本机模式可同时保存到本地路径。没有文件服务的入口由调用方保持原样输出。
 */
export async function deliverFile(
  ctx: ServerContext,
  target: DownloadTarget,
  meta: { name: string; mime?: string; size?: number; extra?: Record<string, unknown> },
  saveTo?: string,
) {
  const f = files(ctx)
  // 先签票据：代理路径不在白名单时直接拒绝，不会先写出本地文件
  let ticket
  try {
    ticket = f.tickets.issueDownload(ctx.env.ownerId, { ...target, name: meta.name })
  } catch (err) {
    if (err instanceof TicketError) throw new CapabilityError(err.message)
    throw err
  }
  const saved = saveTo ? await saveLocal(ctx, f, target, saveTo) : undefined
  const info = {
    ...meta.extra,
    name: meta.name,
    ...(meta.mime ? { mime: meta.mime } : {}),
    ...(meta.size !== undefined ? { size: meta.size } : {}),
    download_url: ticket.url,
    expires: new Date(ticket.expires).toISOString(),
    ...(saved ? { saved_to: saved } : {}),
  }
  return content([
    { type: 'text', text: JSON.stringify(info, null, 1) },
    {
      type: 'resource_link',
      uri: ticket.url,
      name: meta.name,
      ...(meta.mime ? { mimeType: meta.mime } : {}),
      description: '短期只读下载地址，直接 GET 即可，到期后重新调用本工具',
    },
  ])
}

export const downloadAsset = serverCapability({
  name: 'download_asset',
  title: '取出文件',
  description:
    '把资产库里的文件取出给外部使用：返回带短期票据的下载地址 download_url（同时以 MCP resource_link 内容块给出，GET 即可，不需要令牌或 Cookie；约 10 分钟内可重复下载，过期后重新调用）。资产 id 来自 import_asset、get_canvas 里元素的 assetId、节点结果或 search_media。本机模式可加 save_to 直接存到本地路径。',
  group: 'media',
  where: 'server',
  effect: (a) => (a.save_to ? 'edit' : 'read'),
  input: z.object({ id: id.describe('资产 id'), save_to: SAVE_TO }),
  run: (ctx, a) => {
    const asset = ctx.env.assets.get(ctx.env.ownerId, a.id)
    if (!asset) throw new CapabilityError(`资产 ${a.id} 不存在`)
    return deliverFile(
      ctx,
      { kind: 'asset', assetId: asset.id },
      { name: asset.name, mime: asset.mime, size: asset.size, extra: { asset_id: asset.id } },
      a.save_to,
    )
  },
})

export const fileCapabilities = [importAsset, requestUpload, downloadAsset]
export { SAVE_TO as saveToField }
