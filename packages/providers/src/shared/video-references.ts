import { type AssetRef, type ProviderContext, ProviderError } from '@plein/plugin-sdk'

/** 平台按 data URL 的子类型认格式（只认 wav / mp3），MP3 的标准 MIME audio/mpeg 会被当成 .mpeg */
const AUDIO_FORMAT: Record<string, string> = {
  'audio/x-wav': 'audio/wav',
  'audio/mpeg': 'audio/mp3',
}

/** Encode local references through the host, never exposing a local path or secret URL. */
export async function videoReferences(
  refs: AssetRef[],
  ctx: Pick<ProviderContext, 'files'>,
  limits: {
    image: number
    video: number
    audio: number
    duration: number
    allowAudioOnly?: boolean
    platform?: 'minimax' | 'ark'
    minVideoDuration?: number
    uploadVideo?: (
      ref: AssetRef,
      file: Awaited<ReturnType<ProviderContext['files']['read']>>,
    ) => Promise<string>
  },
) {
  const ark = limits.platform === 'ark'
  const counts = { image: 0, video: 0, audio: 0 }
  for (const ref of refs) {
    if (ark && ref.kind === 'video' && !limits.uploadVideo)
      throw new ProviderError('invalid_input', '火山方舟本地视频参考需要配置 TOS 上传通路')
    if (!Object.hasOwn(counts, ref.kind))
      throw new ProviderError('invalid_input', '不支持这种参考素材')
    const kind = ref.kind as keyof typeof counts
    if (++counts[kind] > limits[kind])
      throw new ProviderError(
        'invalid_input',
        `参考${kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '图片'}数量超过上限 ${limits[kind]}`,
      )
  }
  if (counts.audio && !counts.image && !counts.video && !limits.allowAudioOnly)
    throw new ProviderError('invalid_input', '当前模型的音频参考需要搭配图片或视频')
  const totals = { video: 0, audio: 0 }
  const content: Array<Record<string, unknown>> = []
  const uploads: Array<{
    index: number
    ref: AssetRef
    file: Awaited<ReturnType<ProviderContext['files']['read']>>
  }> = []
  let bytes = 0
  for (const ref of refs) {
    const file = await ctx.files.read(ref)
    const mime = file.mime.toLowerCase()
    const kind = ref.kind as keyof typeof counts
    const accepted =
      kind === 'image'
        ? (ark
            ? /^image\/(jpeg|png|webp|bmp|tiff|gif|heic|heif)$/
            : /^image\/(jpeg|png|webp|heic|heif)$/
          ).test(mime)
        : kind === 'video'
          ? ['video/mp4', 'video/quicktime'].includes(mime)
          : ['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3'].includes(mime)
    const max = kind === 'image' ? 30 : kind === 'video' ? (ark ? 200 : 50) : 15
    if (!accepted || !file.data.length || file.data.length > max * 1024 * 1024)
      throw new ProviderError(
        'invalid_input',
        `参考素材格式或大小不符合要求（${kind}，最多 ${max} MB）`,
      )
    if (kind === 'video' && limits.platform) {
      if (!file.videoCodec || !['h264', 'hevc'].includes(file.videoCodec))
        throw new ProviderError(
          'invalid_input',
          '参考视频编码须为 H.264/AVC 或 H.265/HEVC，且编码信息可读取',
        )
      if (
        typeof file.frameRate !== 'number' ||
        !Number.isFinite(file.frameRate) ||
        file.frameRate < (ark ? 24 : 23.976) ||
        file.frameRate > 60
      )
        throw new ProviderError(
          'invalid_input',
          `参考视频帧率须为 ${ark ? '24' : '23.976'}–60 fps，且帧率可读取`,
        )
      if (
        !Array.isArray(file.audioCodecs) ||
        file.audioCodecs.some(
          (codec) =>
            !(
              ['aac', 'mp3'].includes(codec) ||
              (ark && mime === 'video/quicktime' && codec.startsWith('pcm_'))
            ),
        )
      )
        throw new ProviderError('invalid_input', '参考视频音轨编码不符合要求，或音轨信息无法读取')
    }
    if (kind === 'image' && ark && file.data.length === max * 1024 * 1024)
      throw new ProviderError('invalid_input', '火山方舟参考图片必须小于 30 MB')
    if (kind !== 'audio') {
      const { width, height } = file
      const min = ark ? 300 : 256
      const maxEdge = ark ? 6000 : 5760
      if (
        typeof width !== 'number' ||
        typeof height !== 'number' ||
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < min ||
        height < min ||
        width > maxEdge ||
        height > maxEdge ||
        width / height < 0.4 ||
        width / height > 2.5
      )
        throw new ProviderError(
          'invalid_input',
          `参考素材需要可读取的尺寸，宽高须为 ${min}–${maxEdge} 像素，宽高比为 0.4–2.5`,
        )
    }
    if (kind !== 'image') {
      if (
        typeof file.duration !== 'number' ||
        !Number.isFinite(file.duration) ||
        file.duration < 2 ||
        file.duration > limits.duration
      )
        throw new ProviderError(
          'invalid_input',
          `参考素材需要可读取的时长，范围为 2–${limits.duration} 秒`,
        )
      if (kind === 'video' && file.duration < (limits.minVideoDuration ?? 2))
        throw new ProviderError(
          'invalid_input',
          `当前任务参考视频至少需要 ${limits.minVideoDuration} 秒`,
        )
      totals[kind] += file.duration
      if (totals[kind] > limits.duration)
        throw new ProviderError(
          'invalid_input',
          `参考${kind === 'video' ? '视频' : '音频'}总时长不能超过 ${limits.duration} 秒`,
        )
    }
    if (ark && kind === 'video') {
      const pixels = file.width! * file.height!
      if (pixels < 407696 || pixels > 8295044)
        throw new ProviderError('invalid_input', '火山参考视频总像素须为 407696–8295044')
      uploads.push({ index: content.length, ref, file })
      content.push({ type: 'video_url', role: 'reference_video' })
      continue
    }
    const encoded = Buffer.from(file.data).toString('base64')
    bytes += encoded.length
    if (bytes > 63 * 1024 * 1024)
      throw new ProviderError('invalid_input', '参考素材编码后超过请求上限，请缩短或压缩素材')
    const type = `${kind}_url`
    content.push({
      type,
      [type]: { url: `data:${AUDIO_FORMAT[mime] ?? mime};base64,${encoded}` },
      role: `reference_${kind}`,
    })
  }
  // 所有素材校验完成后才上传，避免后续非法素材导致无用的远端写入。
  for (const { index, ref, file } of uploads)
    content[index] = { ...content[index], video_url: { url: await limits.uploadVideo!(ref, file) } }
  return content
}
