import { animaticNode, arrangeAnimatic, sequenceSpec, subtitleExportProblem } from '@plein/nodes'
import { defineExecutor, ProviderError } from '@plein/plugin-sdk'
import sharp from 'sharp'
import { mediaCaps, missingCapability } from '../assets/media'

export const animaticExecutor = defineExecutor(animaticNode, async (ctx) => {
  const rows = arrangeAnimatic(ctx.params)
  if (!rows.length)
    throw new ProviderError('invalid_input', '样片还没有镜头，请从分镜表创建或更新样片')
  const problem = subtitleExportProblem(ctx.params, rows)
  if (problem) throw new ProviderError('invalid_input', problem, { retryable: false })
  const probe = (id: string) => ctx.media.probe({ assetId: id, kind: 'audio' })
  const [dialogue, more] = await Promise.all([
    Promise.all(
      rows.map(async (r) => (r.dialogue ? (await probe(r.dialogue.assetId)).duration : undefined)),
    ),
    Promise.all(
      rows.map((r) => Promise.all(r.more.map(async (m) => (await probe(m.assetId)).duration))),
    ),
  ])
  const spec = sequenceSpec(
    ctx.params,
    rows,
    { clips: ctx.params.shots.map((s) => s.duration), dialogue, more },
    undefined,
    '样片-草稿',
  )
  const caps = await mediaCaps()
  if (spec.subtitles?.cues.length && !caps.subtitles)
    throw new ProviderError('unavailable', missingCapability('subtitles'), { retryable: false })
  for (const [i, clip] of spec.clips.entries()) {
    ctx.progress(i / (spec.clips.length + 1), `准备样片镜头 ${i + 1}…`)
    const image = clip.asset.assetId ? await ctx.assets.read(clip.asset) : undefined
    const base = image
      ? sharp(image.data).resize(spec.width, spec.height, { fit: 'contain', background: '#151515' })
      : sharp({
          create: { width: spec.width, height: spec.height, channels: 3, background: '#30343b' },
        })
    const label = `<svg width="${spec.width}" height="${spec.height}"><rect width="${spec.width}" height="70" fill="#111" fill-opacity=".85"/><text x="24" y="46" fill="white" font-family="sans-serif" font-size="30">DRAFT / STORYBOARD ${i + 1}${image ? '' : ' / MISSING IMAGE'}</text></svg>`
    const bytes = await base
      .composite([{ input: Buffer.from(label) }])
      .png()
      .toBuffer()
    clip.asset = await ctx.assets.put({
      data: new Uint8Array(bytes),
      mime: 'image/png',
      name: `样片草稿-${i + 1}.png`,
    })
  }
  ctx.progress(0.8, '本地导出节奏样片…')
  const output = await ctx.media.compose(spec)
  return { video: [{ type: 'video', ...output }] }
})
