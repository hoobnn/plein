import { defineNode } from '@plein/plugin-sdk'
import { z } from 'zod'

export const DELIVERY_CHECK_TYPE = 'plein/delivery-check'
export const DELIVERY_CHECK_LIMITS = {
  duration: 600,
  inputBytes: 512 * 1024 * 1024,
  dimension: 4096,
  frames: 1_000_000,
  timeoutMs: 10 * 60_000,
  reportBytes: 512 * 1024,
  intervals: 1000,
  cues: 5000,
} as const
export const DELIVERY_CHECK_RULES = {
  version: 1,
  durationTolerance: 0.05,
  blackSeconds: 0.5,
  blackPixel: 0.1,
  blackRatio: 0.98,
  silenceDb: -50,
  silenceSeconds: 0.5,
} as const
const id = z.string().min(1).max(200)
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const finite = z.number().finite()
export const SubtitlePlanEvidence = z.object({
  version: z.literal(1),
  basis: z.literal('executed-sequence-spec'),
  enabled: z.boolean(),
  cues: z
    .array(z.object({ start: finite, end: finite, text: z.string().max(4000) }))
    .max(DELIVERY_CHECK_LIMITS.cues),
})
export const DeliveryCheckRequest = z.object({
  scope: z.object({ canvasId: id, boardId: id, sequenceId: id }),
  deliveryId: id,
  runId: id,
  resultId: id,
  source: z.object({
    assetId: hash,
    kind: z.literal('video'),
    mime: z.string().max(100).optional(),
  }),
  goal: z.object({ id, snapshot: z.string().min(1).max(16_384) }),
  subtitles: SubtitlePlanEvidence.extend({ assetId: hash, resultId: id }).optional(),
})
export type DeliveryCheckRequest = z.infer<typeof DeliveryCheckRequest>
export const DeliveryCheckState = z.enum(['passed', 'issues', 'unchecked', 'failed'])
export const DeliveryCheckReport = z
  .object({
    format: z.literal('plein-delivery-check'),
    version: z.literal(1),
    request: DeliveryCheckRequest,
    at: finite.nonnegative(),
    rules: z.object({
      version: z.literal(1),
      durationTolerance: z.literal(0.05),
      blackSeconds: z.literal(0.5),
      blackPixel: z.literal(0.1),
      blackRatio: z.literal(0.98),
      silenceDb: z.literal(-50),
      silenceSeconds: z.literal(0.5),
    }),
    engine: z.string().min(1).max(300),
    status: DeliveryCheckState,
    checks: z
      .array(
        z.object({
          id: z.enum([
            'source',
            'decode',
            'spec',
            'duration',
            'audio',
            'subtitles',
            'black',
            'silence',
          ]),
          status: DeliveryCheckState,
          detail: z.string().max(1000),
        }),
      )
      .min(8)
      .max(8),
    observed: z.object({
      sha256: hash.optional(),
      bytes: finite.nonnegative().optional(),
      width: finite.positive().optional(),
      height: finite.positive().optional(),
      sar: finite.positive().optional(),
      duration: finite.positive().optional(),
      firstVideoPts: finite.optional(),
      lastVideoPts: finite.optional(),
      lastFrameDuration: finite.nonnegative().optional(),
      firstAudioPts: finite.optional(),
      audioEndPts: finite.optional(),
      audioCodecs: z.array(z.string().max(50)).max(100).optional(),
      audioUncovered: z
        .array(z.object({ start: finite.nonnegative(), end: finite.nonnegative() }))
        .max(DELIVERY_CHECK_LIMITS.intervals)
        .optional(),
      decodedFrames: z.number().int().nonnegative().max(DELIVERY_CHECK_LIMITS.frames),
      audioTracks: z.number().int().nonnegative().max(100),
      audioDecoded: z.boolean(),
      complete: z.boolean(),
      black: z
        .array(z.object({ start: finite.nonnegative(), end: finite.nonnegative() }))
        .max(DELIVERY_CHECK_LIMITS.intervals),
      silence: z
        .array(z.object({ start: finite.nonnegative(), end: finite.nonnegative() }))
        .max(DELIVERY_CHECK_LIMITS.intervals),
    }),
    unchecked: z.array(z.string().max(500)).max(20),
  })
  .superRefine((report, ctx) => {
    const ids = report.checks.map((c) => c.id)
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: '检查项身份重复' })
    if (
      report.checks.find((check) => check.id === 'source')?.status === 'passed' &&
      report.observed.sha256 !== report.request.source.assetId
    )
      ctx.addIssue({ code: 'custom', message: '通过的源文件检查必须有相符的实际哈希' })
    if (
      report.checks.find((check) => check.id === 'decode')?.status === 'passed' &&
      (!report.observed.complete || report.observed.decodedFrames < 1)
    )
      ctx.addIssue({ code: 'custom', message: '通过的解码检查必须完整且有实际解码帧' })
    const states = report.checks.map((c) => c.status)
    const expected = states.includes('failed')
      ? 'failed'
      : states.includes('issues')
        ? 'issues'
        : states.includes('unchecked')
          ? 'unchecked'
          : 'passed'
    if (report.status !== expected || (report.status === 'passed' && !report.observed.complete))
      ctx.addIssue({ code: 'custom', message: '报告状态与实际检查不一致' })
    if (
      report.checks.find((check) => check.id === 'silence')?.status === 'passed' &&
      (report.observed.audioTracks !== 1 ||
        !report.observed.audioDecoded ||
        !report.observed.audioUncovered ||
        report.observed.audioUncovered.length)
    )
      ctx.addIssue({ code: 'custom', message: '静音通过要求已知且完整的单轨样本覆盖' })
    for (const interval of [
      ...report.observed.black,
      ...report.observed.silence,
      ...(report.observed.audioUncovered ?? []),
    ])
      if (
        interval.end <= interval.start ||
        (report.observed.duration !== undefined &&
          interval.end > report.observed.duration + DELIVERY_CHECK_RULES.durationTolerance)
      )
        ctx.addIssue({ code: 'custom', message: '检测区间越界' })
    if (
      report.request.subtitles &&
      (report.request.subtitles.assetId !== report.request.source.assetId ||
        report.request.subtitles.resultId !== report.request.resultId)
    )
      ctx.addIssue({ code: 'custom', message: '字幕计划不属于实际输出' })
  })
export type DeliveryCheckReport = z.infer<typeof DeliveryCheckReport>

export function deliveryCheckAssets(value: unknown): string[] {
  const parsed = DeliveryCheckReport.safeParse(value)
  return parsed.success ? [parsed.data.request.source.assetId] : []
}
export const deliveryCheckNode = defineNode({
  type: DELIVERY_CHECK_TYPE,
  version: 1,
  title: '成片技术检查',
  description: '检查固定导出文件与制作目标的本地技术条件；不调用模型、不代替人工交付确认',
  category: 'util',
  execution: 'job',
  inputs: [],
  outputs: [{ id: 'report', label: '技术报告', type: 'json' }],
  params: z.object({
    historical: z.boolean().default(false).meta({ title: '副本历史报告', widget: 'hidden' }),
    request: DeliveryCheckRequest.optional().meta({ title: '固定检查对象', widget: 'hidden' }),
  }),
})
