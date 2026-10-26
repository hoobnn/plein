import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import sharp from 'sharp'
import {
  PANORAMA_MAX_BYTES,
  PANORAMA_MAX_PIXELS,
  PanoramaCaptureRequest,
  SceneViews,
  isEquirectangular,
  panoramaSceneRevision,
  panoramaSize,
  projectPanorama,
  sceneViewProblem,
} from '@plein/nodes'
import type { LibraryItem } from '@plein/protocol'
import type { AssetStore } from '../assets/store'
import type { LibraryStore } from './store'

export class PanoramaCaptureError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message)
  }
}

/** Capture and confirm the same owned scene source. Recheck after every expensive async stage. */
export async function capturePanoramaView(
  assets: AssetStore,
  library: LibraryStore,
  owner: string,
  libraryId: string,
  raw: unknown,
  signal: AbortSignal,
  canWrite: () => boolean,
): Promise<LibraryItem> {
  if (!canWrite()) throw new PanoramaCaptureError('只读成员不能保存场景视角', 403)
  const parsed = PanoramaCaptureRequest.safeParse(raw)
  if (!parsed.success) throw new PanoramaCaptureError('全景截图参数不合法', 400)
  const input = parsed.data
  const check = () => {
    signal.throwIfAborted()
    if (!canWrite()) throw new PanoramaCaptureError('编辑权限已变化，未保存视角', 403)
    const item = library.get(owner, libraryId)
    if (!item) throw new PanoramaCaptureError('原场景不存在', 404)
    if (
      item.kind !== 'scene' ||
      panoramaSceneRevision(item) !== input.expected ||
      !item.images.some(
        (image) => image.slot === 'panorama' && image.assetId === input.sourceAssetId,
      )
    )
      throw new PanoramaCaptureError('场景或全景原图已变化，请重新打开全景核对', 409)
    const views = SceneViews.safeParse(item.sceneViews ?? [])
    if (!views.success) throw new PanoramaCaptureError('场景视角数据需要修复后再添加', 409)
    if (views.data.length >= 24) throw new PanoramaCaptureError('每个场景最多保存 24 个视角', 409)
    const problem = sceneViewProblem(views.data, input.name)
    if (problem) throw new PanoramaCaptureError(problem, 409)
    const asset = assets.get(owner, input.sourceAssetId)
    if (!asset || asset.kind !== 'image' || !existsSync(assets.originalPath(input.sourceAssetId)))
      throw new PanoramaCaptureError('全景原图不存在或不属于当前用户', 404)
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/avif'].includes(asset.mime))
      throw new PanoramaCaptureError('全景仅支持 PNG、JPEG、WebP 或 AVIF 图片', 400)
    if (
      asset.size > PANORAMA_MAX_BYTES ||
      !asset.width ||
      !asset.height ||
      asset.width * asset.height > PANORAMA_MAX_PIXELS
    )
      throw new PanoramaCaptureError('全景原图不能超过 3200 万像素或 64 MiB', 400)
    return { item, views: views.data }
  }
  return assets.activity.run(async () => {
    check()
    let original: Uint8Array
    try {
      original = await assets.readOriginal(owner, input.sourceAssetId)
    } catch {
      throw new PanoramaCaptureError('全景原件缺失或校验失败，请恢复原图', 404)
    }
    check()
    const decoded = await sharp(original, { limitInputPixels: PANORAMA_MAX_PIXELS })
      .rotate()
      .resize({ width: 4096, height: 2048, fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    check()
    if (!isEquirectangular(decoded.info.width, decoded.info.height))
      throw new PanoramaCaptureError('需要 2:1 等距柱状全景图片，普通宽图不能作为全景', 400)
    const size = panoramaSize(input.pose.format)
    const pixels = projectPanorama(
      decoded.data,
      decoded.info.width,
      decoded.info.height,
      input.pose,
      size.width,
      size.height,
    )
    const png = await sharp(Buffer.from(pixels), { raw: { ...size, channels: 4 } })
      .png()
      .toBuffer()
    check()
    const captured = await assets.ingest(owner, Readable.from([png]), {
      mime: 'image/png',
      name: `${input.name}.png`,
    })
    const { views } = check()
    const description = [
      input.description.trim(),
      `全景截取：朝向 ${input.pose.yaw}°，俯仰 ${input.pose.pitch}°，垂直视角 ${input.pose.fov}°。`,
    ]
      .filter(Boolean)
      .join('\n')
    return library.update(owner, libraryId, {
      sceneViews: [
        ...views,
        {
          id: randomUUID(),
          name: input.name,
          aliases: [],
          description,
          images: [captured.id],
          panorama: { assetId: input.sourceAssetId, ...input.pose },
        },
      ],
    })!
  })
}
