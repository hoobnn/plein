import { z } from 'zod'

export const PANORAMA_MAX_PIXELS = 32_000_000
export const PANORAMA_MAX_BYTES = 64 * 1024 * 1024
export const PanoramaPose = z.object({
  yaw: z.number().min(-180).max(180),
  pitch: z.number().min(-80).max(80),
  fov: z.number().min(25).max(100),
  format: z.enum(['landscape', 'portrait', 'square']),
})
export type PanoramaPose = z.infer<typeof PanoramaPose>
export const PanoramaViewSource = PanoramaPose.extend({
  assetId: z.string().regex(/^[0-9a-f]{64}$/),
})
export const PanoramaCaptureRequest = z.object({
  sourceAssetId: z.string().regex(/^[0-9a-f]{64}$/),
  expected: z.string().min(1).max(100_000),
  name: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[^/@#\s]+$/),
  description: z.string().max(800).default(''),
  pose: PanoramaPose,
})
export type PanoramaCaptureRequest = z.input<typeof PanoramaCaptureRequest>
export const panoramaSize = (format: PanoramaPose['format']) =>
  format === 'portrait'
    ? { width: 576, height: 1024 }
    : format === 'square'
      ? { width: 1024, height: 1024 }
      : { width: 1024, height: 576 }
export const isEquirectangular = (width: number, height: number) =>
  Number.isSafeInteger(width) &&
  Number.isSafeInteger(height) &&
  width >= 4 &&
  height >= 2 &&
  Math.abs(width / (height * 2) - 1) <= 0.005

/** Usage timestamps do not change the scene content displayed in a capture confirmation. */
export function panoramaSceneRevision(item: {
  id: string
  kind: string
  projectId: string | null
  name: string
  updatedAt: number
  images: unknown
  sceneViews?: unknown
  description?: unknown
  tags?: unknown
}) {
  return JSON.stringify([
    'panorama-v1',
    item.id,
    item.kind,
    item.projectId,
    item.name,
    item.updatedAt,
    item.images,
    item.sceneViews ?? [],
    item.description,
    item.tags,
  ])
}

/** Equirectangular longitude/latitude sampled through a perspective pinhole camera, not a crop. */
export function projectPanorama(
  source: ArrayLike<number>,
  sourceWidth: number,
  sourceHeight: number,
  pose: Pick<PanoramaPose, 'yaw' | 'pitch' | 'fov'>,
  width: number,
  height: number,
) {
  if (
    !isEquirectangular(sourceWidth, sourceHeight) ||
    source.length !== sourceWidth * sourceHeight * 4
  )
    throw new Error('需要 2:1 等距柱状全景图片')
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 1024 ||
    height > 1024
  )
    throw new Error('投影输出不能超过 1024×1024')
  if (
    ![pose.yaw, pose.pitch, pose.fov].every(Number.isFinite) ||
    Math.abs(pose.yaw) > 180 ||
    Math.abs(pose.pitch) > 80 ||
    pose.fov < 25 ||
    pose.fov > 100
  )
    throw new Error('全景相机参数不合法')
  const rad = Math.PI / 180
  const cy = Math.cos(pose.yaw * rad),
    sy = Math.sin(pose.yaw * rad)
  const cp = Math.cos(pose.pitch * rad),
    sp = Math.sin(pose.pitch * rad)
  const scale = Math.tan((pose.fov * rad) / 2)
  const aspect = width / height
  const output = new Uint8ClampedArray(width * height * 4)
  const xs = Array.from({ length: width }, (_, x) => (((x + 0.5) / width) * 2 - 1) * aspect * scale)
  for (let y = 0; y < height; y++) {
    const vy = (1 - ((y + 0.5) / height) * 2) * scale
    const dy = vy * cp + sp,
      dz = cp - vy * sp
    for (let x = 0; x < width; x++) {
      const dx = xs[x]!
      const wx = dx * cy + dz * sy,
        wz = dz * cy - dx * sy
      const u = (Math.atan2(wx, wz) / (2 * Math.PI) + 0.5) * sourceWidth - 0.5
      const v = Math.max(
        0,
        Math.min(
          sourceHeight - 1,
          (0.5 - Math.atan2(dy, Math.hypot(wx, wz)) / Math.PI) * sourceHeight - 0.5,
        ),
      )
      const ux = Math.floor(u),
        x0 = ((ux % sourceWidth) + sourceWidth) % sourceWidth
      const x1 = (x0 + 1) % sourceWidth,
        y0 = Math.floor(v),
        y1 = Math.min(y0 + 1, sourceHeight - 1)
      const fx = u - ux,
        fy = v - y0
      const a = (y0 * sourceWidth + x0) * 4,
        b = (y0 * sourceWidth + x1) * 4
      const c = (y1 * sourceWidth + x0) * 4,
        d = (y1 * sourceWidth + x1) * 4
      const at = (y * width + x) * 4
      for (let channel = 0; channel < 4; channel++)
        output[at + channel] =
          (source[a + channel]! * (1 - fx) + source[b + channel]! * fx) * (1 - fy) +
          (source[c + channel]! * (1 - fx) + source[d + channel]! * fx) * fy
    }
  }
  return output
}
