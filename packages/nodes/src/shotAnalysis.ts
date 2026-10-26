import { defineNode } from '@plein/plugin-sdk'
import { z } from 'zod'

export const SHOT_ANALYSIS_TYPE = 'plein/shot-analysis'
export const SHOT_ANALYSIS_LIMITS = {
  duration: 600,
  inputBytes: 512 * 1024 * 1024,
  dimension: 4096,
  scenes: 100,
  outputBytes: 1024 * 1024 * 1024,
  timeoutMs: 10 * 60_000,
} as const

const hash = z.string().regex(/^[0-9a-f]{64}$/)
const image = z.object({ assetId: hash, kind: z.literal('image'), mime: z.literal('image/jpeg') })
const video = z.object({
  assetId: hash,
  kind: z.literal('video'),
  mime: z
    .string()
    .regex(/^video\/[\w.+-]+$/)
    .max(100),
})
const audio = z.object({ assetId: hash, kind: z.literal('audio'), mime: z.literal('audio/mp4') })

/** Only this manifest declares JSON result asset references; arbitrary JSON is not scanned. */
export const ShotAnalysisManifest = z
  .object({
    version: z.literal(1),
    source: video,
    timeBasis: z.literal('first-video-frame'),
    firstVideoPts: z.number().finite(),
    duration: z.number().positive().max(SHOT_ANALYSIS_LIMITS.duration),
    algorithm: z.object({
      name: z.literal('ffmpeg-scene'),
      version: z.literal(1),
      threshold: z.number().min(0.01).max(1),
      minSceneSeconds: z.number().min(0.1).max(30),
      manual: z.boolean(),
    }),
    scenes: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          start: z.number().nonnegative(),
          end: z.number().positive(),
          frame: image.extend({
            /** Requested sample time; actualAt is present only when FFmpeg reports a decoded PTS. */
            at: z.number().nonnegative(),
            actualAt: z.number().nonnegative().optional(),
            actualEnd: z.number().positive().optional(),
          }),
          clip: video.optional(),
        }),
      )
      .min(1)
      .max(SHOT_ANALYSIS_LIMITS.scenes),
    audio: audio.optional(),
    notes: z.array(z.string().max(1000)).max(20),
  })
  .superRefine((manifest, ctx) => {
    const ids = new Set<string>()
    let end = 0
    for (const [index, scene] of manifest.scenes.entries()) {
      if (
        ids.has(scene.id) ||
        Math.abs(scene.start - end) > 0.000001 ||
        scene.end <= scene.start ||
        scene.end > manifest.duration + 0.000001 ||
        scene.frame.at < scene.start ||
        scene.frame.at >= scene.end ||
        (scene.frame.actualAt === undefined) !== (scene.frame.actualEnd === undefined) ||
        (scene.frame.actualAt !== undefined &&
          scene.frame.actualEnd !== undefined &&
          (scene.frame.actualAt > scene.frame.at + 0.000001 ||
            scene.frame.actualEnd <= scene.frame.at ||
            scene.frame.actualEnd > manifest.duration + 0.000001))
      )
        ctx.addIssue({
          code: 'custom',
          path: ['scenes', index],
          message: '镜头身份、连续区间或采样时间不合法',
        })
      ids.add(scene.id)
      if (
        !manifest.algorithm.manual &&
        manifest.scenes.length > 1 &&
        scene.end - scene.start + 0.000001 < manifest.algorithm.minSceneSeconds
      )
        ctx.addIssue({
          code: 'custom',
          path: ['scenes', index],
          message: '自动切点不得产生短于最短镜头设置的区间',
        })
      end = scene.end
    }
    if (Math.abs(end - manifest.duration) > 0.000001)
      ctx.addIssue({ code: 'custom', path: ['scenes'], message: '镜头须连续覆盖整个视频' })
  })
export type ShotAnalysisManifest = z.infer<typeof ShotAnalysisManifest>

export const shotAnalysisNode = defineNode({
  type: SHOT_ANALYSIS_TYPE,
  version: 1,
  title: '本地拉片',
  description: '本地检测视频切点，编辑区间后提取关键帧、片段和原音轨；不调用模型',
  category: 'video',
  execution: 'job',
  inputs: [{ id: 'video', label: '原视频', type: 'video', required: true }],
  outputs: [{ id: 'analysis', label: '拉片清单', type: 'json' }],
  params: z.object({
    threshold: z.number().min(0.01).max(1).default(0.35).meta({ title: '切镜阈值' }),
    minSceneSeconds: z.number().min(0.1).max(30).default(0.6).meta({ title: '最短镜头（秒）' }),
    cutPlan: z
      .object({
        sourceAssetId: hash,
        points: z.array(z.number().finite().positive()).max(SHOT_ANALYSIS_LIMITS.scenes - 1),
      })
      .optional()
      .meta({ title: '人工切点', widget: 'hidden' }),
    clips: z.boolean().default(false).meta({ title: '提取视频片段' }),
    audio: z.boolean().default(false).meta({ title: '提取第一条原音轨' }),
  }),
})

/** Strict order: a malformed plan is rejected rather than silently sorted or clamped. */
export function shotAnalysisRanges(duration: number, points: readonly number[]) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > SHOT_ANALYSIS_LIMITS.duration)
    throw new Error('视频时长必须在 0 到 600 秒之间')
  if (points.length >= SHOT_ANALYSIS_LIMITS.scenes) throw new Error('镜头数量超过 100 个')
  let previous = 0
  for (const point of points) {
    if (!Number.isFinite(point) || point <= previous || point >= duration)
      throw new Error('切点须按时间递增，且位于视频起点和终点之间')
    previous = point
  }
  const boundaries = [0, ...points, duration]
  return boundaries.slice(0, -1).map((start, i) => ({ start, end: boundaries[i + 1]! }))
}

export function shotAnalysisAssets(value: unknown): string[] {
  const parsed = ShotAnalysisManifest.safeParse(value)
  if (!parsed.success) return []
  const m = parsed.data
  return [
    ...new Set([
      m.source.assetId,
      ...m.scenes.flatMap((scene) => [
        scene.frame.assetId,
        ...(scene.clip ? [scene.clip.assetId] : []),
      ]),
      ...(m.audio ? [m.audio.assetId] : []),
    ]),
  ]
}
