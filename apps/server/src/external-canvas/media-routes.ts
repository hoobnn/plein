import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createElement } from '@plein/doc'
import {
  ExternalMediaImport,
  ExternalMediaReplace,
  ExternalMediaPublish,
  ExternalTarget,
  type ExternalPlatform,
  type RemoteMedia,
} from '@plein/protocol'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AuthEnv } from '../auth'
import { probeImage, probeMedia } from '../assets/media'
import type { AssetStore } from '../assets/store'
import { ownsCanvas } from '../storage/canvases'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'
import { mediaExportStore } from './media-export-store'
import { canonicalTarget } from './targets'
import { ProjectQueue } from './project-queue'
import { jimengCanvasMedia } from './jimeng-canvas-media'
import { jimengNovelMedia } from './jimeng-novel-media'
import type { ExternalMediaProvider } from './media-provider'

class SelectionChanged extends Error {}
const stale = () => new SelectionChanged('所选素材已变更，请重新载入版本列表。')

/** Detect the container from bytes before giving it to a decoder. Remote URLs,
 * playlists, SVGs and arbitrary files do not represent an importable media stream. */
function containerMime(b: Buffer, kind: RemoteMedia['kind']) {
  const ascii = (offset: number, text: string) =>
    b.toString('latin1', offset, offset + text.length) === text
  if (kind === 'image') {
    if (b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
    if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
    if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif'
    if (ascii(4, 'ftypavif') || ascii(4, 'ftypavis')) return 'image/avif'
  } else {
    if (ascii(4, 'ftyp'))
      return kind === 'audio' ? 'audio/mp4' : ascii(8, 'qt  ') ? 'video/quicktime' : 'video/mp4'
    if (b.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex')) && b.includes(Buffer.from('webm')))
      return kind + '/webm'
    if (ascii(0, 'OggS')) return kind + '/ogg'
    if (kind === 'audio') {
      if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return 'audio/wav'
      if (ascii(0, 'fLaC')) return 'audio/flac'
      if (b[0] === 0xff && ((b[1] ?? 0) & 0xf6) === 0xf0) return 'audio/aac'
      if (ascii(0, 'ID3') || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0)) return 'audio/mpeg'
    }
  }
  throw new Error('文件内容与选定的媒体类型不符，或暂不支持此容器格式。')
}

async function validateFile(
  path: string,
  kind: RemoteMedia['kind'],
  maxSize: number,
  receipt?: { size: number; sha256: string } | void,
) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.size === 0 ||
      stat.size > maxSize ||
      (receipt && receipt.size !== stat.size)
    )
      throw new Error('素材文件大小异常或超出上传上限。')
    const header = Buffer.alloc(512)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    const mime = containerMime(header.subarray(0, bytesRead), kind)
    if (receipt) {
      const hash = createHash('sha256')
      for await (const chunk of file.createReadStream({ autoClose: false, start: 0 }))
        hash.update(chunk)
      if (hash.digest('hex') !== receipt.sha256) throw new Error('素材校验和与下载回执不一致。')
    }
    const probe = kind === 'image' ? await probeImage(path) : await probeMedia(path)
    if (
      (kind === 'image' && (!probe.width || !probe.height)) ||
      (kind === 'video' && !probe.hasVideo) ||
      (kind === 'audio' && (!probe.hasAudio || probe.hasVideo))
    )
      throw new Error('未找到所选类型的有效媒体内容。')
    return mime
  } finally {
    await file.close()
  }
}

async function localSource(
  assets: AssetStore,
  owner: string,
  id: string,
  dir: string,
  maxSize: number,
  expected?: RemoteMedia['kind'],
) {
  const local = await assets.verifyOriginal(owner, id)
  if (local.kind === 'file' || (expected && local.kind !== expected))
    throw new Error('请选择相同类型的图片、音频或视频。')
  const path = assets.originalPath(local.id)
  const mime = await validateFile(path, local.kind, maxSize)
  const extension =
    mime === 'audio/mp4'
      ? 'm4a'
      : mime.split('/')[1]!.replace('mpeg', 'mp3').replace('quicktime', 'mov')
  const source = join(dir, 'source.' + extension)
  await copyFile(path, source, constants.COPYFILE_EXCL)
  return { path: source, kind: local.kind, title: local.name }
}
export function externalMediaRoutes(
  db: DB,
  rooms: Rooms,
  assets: AssetStore,
  maxSize: number,
  providers: Partial<Record<ExternalPlatform, ExternalMediaProvider>> = {
    'jimeng-canvas': jimengCanvasMedia,
    'jimeng-novel': jimengNovelMedia,
  },
  queue = new ProjectQueue(),
) {
  const list = queue.reader<{ target: string; items: RemoteMedia[] }>()
  const base = '/api/canvases/:canvas/external/media' as const
  const app = new Hono<AuthEnv>()
  app.use(`${base}/*`, async (c, next) => {
    if (!ownsCanvas(db, c.var.principal.id, c.req.param('canvas')!))
      return c.json({ error: 'not_found', message: '画布不存在' }, 404)
    await next()
  })
  app.onError((err, c) => {
    const stale = err instanceof SelectionChanged
    const message =
      err instanceof z.ZodError || err instanceof SyntaxError
        ? 'CLI 回执格式不兼容，请检查版本。'
        : err.message
    return c.json({ error: stale ? 'changed' : 'external_media_error', message }, stale ? 409 : 422)
  })
  app.post(`${base}/list`, async (c) => {
    const ref = ExternalTarget.extend({ includeTarget: z.boolean().optional() }).safeParse(
      await c.req.json().catch(() => null),
    )
    if (!ref.success) return c.json({ error: 'invalid', message: '项目 ID 无效' }, 400)
    const provider = providers[ref.data.provider]
    const target = canonicalTarget(ref.data)
    if (!provider) return c.json(ref.data.includeTarget ? { target: target.target, items: [] } : [])
    const result = await list(c.req.param('canvas'), target, async () => {
      const resolved = (await provider.resolveTarget?.(target.target)) ?? target.target
      return { target: resolved, items: await provider.listMedia(resolved) }
    })
    return c.json(ref.data.includeTarget ? result : result.items)
  })
  app.post(`${base}/publish`, async (c) => {
    const req = ExternalMediaPublish.safeParse(await c.req.json().catch(() => null))
    if (!req.success)
      return c.json({ error: 'invalid', message: '请选择要导出的 Plein 素材。' }, 400)
    const ref = canonicalTarget(req.data)
    const provider = providers[ref.provider]
    const publish = provider?.publish
    if (!provider || !publish)
      return c.json({ error: 'unsupported', message: '此平台未提供素材发布接口。' }, 422)
    const canvas = c.req.param('canvas'),
      owner = c.var.principal.id
    return queue.run(ref, async () => {
      const target = (await provider.resolveTarget?.(ref.target)) ?? ref.target
      return await assets.activity.run(async () => {
        const dir = await assets.tempDir('external-export-')
        try {
          const source = await localSource(assets, owner, req.data.localAssetId, dir, maxSize)
          if (
            !ownsCanvas(db, owner, canvas) ||
            rooms.wasDropped(canvas) ||
            rooms.withDoc(canvas, (doc) => doc.readOnly)
          )
            throw new SelectionChanged('Plein 画布已变更，请刷新。')
          const store = mediaExportStore(db, {
            ...ref,
            target,
            canvasId: canvas,
            localAssetId: req.data.localAssetId,
          })
          const intent = store.begin()
          const result = await publish(target, source, intent.operationId, !!intent.remoteNodeId)
          if (
            intent.remoteNodeId &&
            (intent.remoteNodeId !== result.nodeId || intent.remoteAssetId !== result.assetId)
          )
            throw new SelectionChanged('已验证的发布身份发生变化，请核对即梦项目。')
          store.confirm(intent.operationId, result)
          return c.json(result)
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      })
    })
  })
  for (const op of ['import', 'replace'] as const)
    app.post(`${base}/${op}`, async (c) => {
      const parsed = (op === 'import' ? ExternalMediaImport : ExternalMediaReplace).safeParse(
        await c.req.json().catch(() => null),
      )
      if (!parsed.success) return c.json({ error: 'invalid', message: '素材选择无效' }, 400)
      const input = { ...parsed.data, ...canonicalTarget(parsed.data) }
      const canvas = c.req.param('canvas'),
        owner = c.var.principal.id
      const provider = providers[input.provider]
      if (!provider) return c.json({ error: 'unsupported', message: '此平台未提供素材传输。' }, 422)
      return queue.run(input, () =>
        assets.activity.run(async () => {
          const target = (await provider.resolveTarget?.(input.target)) ?? input.target
          const owned = () => {
            if (!ownsCanvas(db, owner, canvas) || rooms.wasDropped(canvas))
              throw new SelectionChanged('Plein 画布已移除。')
            if (rooms.withDoc(canvas, (doc) => doc.readOnly))
              throw new SelectionChanged('当前画布只读。')
          }
          const selected = async () => {
            const choices = provider.readMedia
              ? await provider.readMedia(target, input.nodeId)
              : await provider.listMedia(target)
            const row = choices.find(
              (m) => m.nodeId === input.nodeId && m.assetId === input.assetId,
            )
            if (!row) throw stale()
            return row
          }
          const media = await selected()
          owned()
          const dir = await assets.tempDir('external-media-')
          try {
            if (op === 'replace') {
              if (
                !media.replaceable ||
                !provider.replace ||
                !('localAssetId' in input) ||
                typeof input.localAssetId !== 'string'
              )
                throw new Error('该版本不支持替换。')
              const source = await localSource(
                assets,
                owner,
                input.localAssetId,
                dir,
                maxSize,
                media.kind,
              )
              owned()
              return c.json({ assetId: await provider.replace(target, media, source.path) })
            }
            const importedId = (target: string) =>
              'el_external_' +
              createHash('sha256')
                .update(
                  JSON.stringify([canvas, input.provider, target, input.nodeId, input.assetId]),
                )
                .digest('hex')
            const file = join(
              dir,
              { image: 'download.png', audio: 'download.mp3', video: 'download.mp4' }[media.kind],
            )
            const receipt = await provider.download(target, media, file)
            const mime = await validateFile(file, media.kind, maxSize, receipt)
            const after = await selected()
            if (after.kind !== media.kind) throw stale()
            owned()
            const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
            let asset
            try {
              asset = await assets.ingest(owner, fd.createReadStream({ autoClose: false }), {
                mime,
                name: after.title || '画布素材',
              })
            } finally {
              await fd.close()
            }
            if (asset.kind !== media.kind) throw new Error('已有素材与所选媒体类型不一致。')
            owned()
            const imported = rooms.withDoc(canvas, (doc) => {
              const elementId = importedId(target)
              const legacy = input.target === target ? undefined : doc.get(importedId(input.target))
              const existing = doc.get(elementId) ?? legacy
              if (existing) {
                if (existing.kind !== media.kind || existing.assetId !== asset.id)
                  throw new SelectionChanged('已导入的元素使用了不同素材，请核对原件。')
                return { elementId: existing.id, created: false }
              }
              const x = Array.from(doc.elements()).reduce(
                (max, e) => (e.parentId ? max : Math.max(max, e.x + e.w + 32)),
                0,
              )
              const w = 320,
                h =
                  asset.width && asset.height
                    ? Math.max(1, Math.round((w * asset.height) / asset.width))
                    : media.kind === 'audio'
                      ? 80
                      : 180
              createElement(doc, {
                id: elementId,
                kind: media.kind,
                x,
                y: 0,
                w,
                h,
                assetId: asset.id,
                name: after.title,
              })
              return { elementId, created: true }
            })
            if (!rooms.get(canvas).persistNow()) throw new Error('画布保存失败，请重试。')
            return c.json(
              { elementId: imported.elementId, assetId: asset.id },
              imported.created ? 201 : 200,
            )
          } finally {
            await rm(dir, { recursive: true, force: true })
          }
        }),
      )
    })
  return app
}
