import { AssetKind, CompositionSourceRef } from '@plein/plugin-sdk'
import { z } from 'zod'
import { Asset } from './assets'

/**
 * 加工操作。图片走 sharp，视频 / 音频走 ffmpeg：
 * crop 对图片和视频可用；rotate/flip 只对图片；separate/frame 只对视频；split 只对音频；
 * trim/speed 对视频和音频都可用（视频变速同时处理音画）。
 * repair-region / replace-range 仅对视频，分别修补像素区域及替换等长画面区间。
 */
export const MediaOp = z.enum([
  'crop',
  'rotate',
  'flip',
  'trim',
  'speed',
  'split',
  'separate',
  'frame',
  'repair-region',
  'replace-range',
])
export type MediaOp = z.infer<typeof MediaOp>

/** 时间区间（秒） */
export const MediaRange = z.object({
  start: z.number().min(0).default(0),
  end: z.number().positive(),
})
export type MediaRange = z.infer<typeof MediaRange>

const assetIdField = z.string().regex(/^[0-9a-f]{64}$/, '资产 id 不合法')
const deriveName = z.string().trim().max(120).optional()

/** 加工请求：一次一个操作，产出的都是新资产，源资产不动 */
export const MediaDeriveRequest = z.discriminatedUnion('op', [
  /** 图片 / 视频裁剪，坐标对应摆正后的像素；视频宽高须为偶数 */
  z.object({
    op: z.literal('crop'),
    assetId: assetIdField,
    left: z.number().int().min(0),
    top: z.number().int().min(0),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    name: deriveName,
  }),
  z.object({
    op: z.literal('rotate'),
    assetId: assetIdField,
    angle: z.union([z.literal(90), z.literal(180), z.literal(270)]),
    name: deriveName,
  }),
  z.object({
    op: z.literal('flip'),
    assetId: assetIdField,
    axis: z.enum(['horizontal', 'vertical']),
    name: deriveName,
  }),
  /** 视频 / 音频截取一段 */
  z.object({
    op: z.literal('trim'),
    assetId: assetIdField,
    start: z.number().min(0).default(0),
    end: z.number().positive(),
    name: deriveName,
  }),
  /** 变速；keepPitch 只对音频有意义（视频变速本来就同步处理音画） */
  z.object({
    op: z.literal('speed'),
    assetId: assetIdField,
    speed: z.number().min(0.25).max(4),
    keepPitch: z.boolean().default(true),
    name: deriveName,
  }),
  /** 音频手动切分：按给的区间切成多个资产 */
  z.object({
    op: z.literal('split'),
    assetId: assetIdField,
    segments: z.array(MediaRange).min(2).max(20),
    name: deriveName,
  }),
  /** 从视频分离出音频与无声视频两个资产 */
  z.object({ op: z.literal('separate'), assetId: assetIdField, name: deriveName }),
  /** 抽帧：任意时刻取一帧，落成图片资产；last 时取最后一帧（续镜用），忽略 at */
  z.object({
    op: z.literal('frame'),
    assetId: assetIdField,
    at: z.number().min(0),
    last: z.boolean().optional(),
    name: deriveName,
  }),
  /** 本地插值修补固定区域；像素坐标对应摆正后的画面，四周须保留背景。 */
  z.object({
    op: z.literal('repair-region'),
    assetId: assetIdField,
    left: z.number().int().min(1),
    top: z.number().int().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    start: z.number().min(0).default(0),
    end: z.number().positive().optional(),
    name: deriveName,
  }),
  /** 用另一视频的等长片段替换原视频区间，保留原音轨，不自动拉伸或补长。 */
  z.object({
    op: z.literal('replace-range'),
    assetId: assetIdField,
    replacementAssetId: assetIdField,
    start: z.number().min(0),
    end: z.number().positive(),
    replacementStart: z.number().min(0).default(0),
    name: deriveName,
  }),
])
export type MediaDeriveRequest = z.infer<typeof MediaDeriveRequest>

const composeRef = z.object({
  assetId: assetIdField,
  kind: AssetKind,
  mime: z.string().optional(),
  compositionSource: CompositionSourceRef.optional(),
})
const composeTransition = z.object({
  type: z.enum(['fade', 'dissolve', 'wipe', 'slide', 'flash']),
  duration: z.number().positive().max(10),
})

/**
 * 导出剪辑工程（OTIO / FCPXML / SRT 和用到的素材打成一个 zip）：
 * 前端按和导出成片同一套规则算出合成参数（ComposeSpec）交上来，服务端只负责打包。
 */
export const SequenceExportRequest = z.object({
  spec: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().min(1).max(120),
    name: z.string().trim().max(120).optional(),
    clips: z
      .array(
        z.object({
          asset: composeRef,
          in: z.number().min(0),
          out: z.number().min(0).optional(),
          volume: z.number().min(0).max(4),
          speed: z.number().min(0.1).max(10).optional(),
          transition: composeTransition.optional(),
        }),
      )
      .min(1)
      .max(500),
    audio: z
      .array(
        z.object({
          asset: composeRef,
          start: z.number().min(0),
          duration: z.number().positive().optional(),
          volume: z.number().min(0).max(4),
          loop: z.boolean().optional(),
          fadeOut: z.number().min(0).optional(),
          envelope: z.array(z.tuple([z.number(), z.number()])).optional(),
        }),
      )
      .max(2000),
    subtitles: z
      .object({
        cues: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
        style: z.enum(['standard', 'bold', 'boxed']),
      })
      .optional(),
    transition: composeTransition.optional(),
    loudnorm: z.boolean().optional(),
  }),
})
export type SequenceExportRequest = z.infer<typeof SequenceExportRequest>

/** 加工结果：产物 + 来源（源资产、操作、参数），供 UI 展示与回溯 */
export const MediaDerivation = z.object({
  source: z.object({ assetId: z.string(), kind: AssetKind, name: z.string() }),
  op: MediaOp,
  /** 参数回显，例如 { start: 1, end: 3 } */
  params: z.record(z.string(), z.unknown()),
  assets: z.array(Asset),
  /** 能力降级等需要如实告知的话，例如本机没有 rubberband */
  note: z.string().optional(),
})
export type MediaDerivation = z.infer<typeof MediaDerivation>

const originMetadata: Partial<Record<MediaOp, Record<string, z.ZodType>>> = {
  'repair-region': { method: z.literal('removelogo'), audio: z.literal('source') },
  'replace-range': {
    frameRate: z.number().positive().max(240),
    frames: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    audio: z.literal('source'),
    fit: z.literal('contain'),
  },
}
const originParams = new Map<MediaOp, z.ZodType>(
  MediaDeriveRequest.options.map((option) => {
    const fields: Record<string, z.ZodType> = { ...option.shape }
    delete fields.op
    delete fields.assetId
    delete fields.name
    // 尾帧的位置可能未知；last=true 时不伪造为0秒。
    if (option.shape.op.value === 'frame') fields.at = z.number().min(0).optional()
    return [
      option.shape.op.value,
      z.object({ ...fields, ...originMetadata[option.shape.op.value] }).strict(),
    ] as const
  }),
)

/** 画布持久化的加工来路，随撤销、检查点及项目包保留；只接受已知操作字段。 */
export const MediaDerivationOrigin = z
  .object({
    version: z.literal(1),
    op: MediaOp,
    source: z
      .object({ assetId: assetIdField, kind: AssetKind, name: z.string().max(4096) })
      .strict(),
    params: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((origin, ctx) => {
    const parsed = originParams.get(origin.op)?.safeParse(origin.params)
    if (!parsed?.success) {
      ctx.addIssue({ code: 'custom', path: ['params'], message: '加工来源参数不符合操作契约' })
      return
    }
    const params = parsed.data as Record<string, unknown>
    if (origin.op === 'frame' && params.last !== true && params.at === undefined)
      ctx.addIssue({ code: 'custom', path: ['params', 'at'], message: '抽帧来源缺少位置' })
    if (
      ['trim', 'repair-region', 'replace-range'].includes(origin.op) &&
      params.end !== undefined &&
      !(Number(params.end) > Number(params.start ?? 0))
    )
      ctx.addIssue({ code: 'custom', path: ['params', 'end'], message: '来源区间的出点须大于入点' })
    const kinds =
      origin.op === 'crop'
        ? ['image', 'video']
        : ['rotate', 'flip'].includes(origin.op)
          ? ['image']
          : origin.op === 'split'
            ? ['audio']
            : ['trim', 'speed'].includes(origin.op)
              ? ['audio', 'video']
              : ['video']
    if (!kinds.includes(origin.source.kind))
      ctx.addIssue({ code: 'custom', path: ['source', 'kind'], message: '来源类型不符合操作契约' })
  })
  .transform((origin) => ({
    ...origin,
    params: originParams.get(origin.op)!.parse(origin.params) as Record<string, unknown>,
  }))
export type MediaDerivationOrigin = z.infer<typeof MediaDerivationOrigin>

/** 仅收集显式来源与片段替换输入，不递归猜测其他字符串中的资产。 */
export function derivationAssets(value: unknown): string[] {
  const parsed = MediaDerivationOrigin.safeParse(value)
  if (!parsed.success) return []
  const ids = [parsed.data.source.assetId]
  if (parsed.data.op === 'replace-range') ids.push(String(parsed.data.params.replacementAssetId))
  return [...new Set(ids)]
}

/**
 * 拼图：把一组图片按顺序拼成一张大图。每格大小一致（取第一张的比例），图片等比放进格子，
 * 留白用底色填；结果是新图片资产，原图不动
 */
export const MediaCollageRequest = z.object({
  assetIds: z.array(assetIdField).min(2).max(64),
  cols: z.number().int().min(1).max(16),
  /** 格子之间和外边的留白（输出像素） */
  gap: z.number().int().min(0).max(128).default(16),
  background: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#ffffff'),
  /** 每格长边（像素），默认按第一张原图，最大 2048 */
  cell: z.number().int().min(64).max(2048).optional(),
  /** 在格子左上角印镜头序号 */
  numbers: z.boolean().default(true),
  name: deriveName,
})
export type MediaCollageRequest = z.input<typeof MediaCollageRequest>

export const MediaCollage = z.object({
  asset: Asset,
  /** 实际像素，界面如实标出 */
  width: z.number(),
  height: z.number(),
  cols: z.number(),
  rows: z.number(),
})
export type MediaCollage = z.infer<typeof MediaCollage>

/** 本机媒体能力，UI 据此隐藏做不到的操作 */
export interface MediaCapsInfo {
  ffmpeg: boolean
  /** 有 ass 滤镜，能烧字幕 */
  subtitles: boolean
  /** 有 rubberband 滤镜，音频变速能真正保音调 */
  rubberband: boolean
  /** 有 removelogo 滤镜，可用周边像素修补矩形区域；旧服务端未探测时不显示入口。 */
  regionRepair?: boolean
}
