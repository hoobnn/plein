import {
  type AssetRef,
  type MediaRequirements,
  type ProviderContext,
  ProviderError,
  mediaRequirementOf,
  mediaRequirementProblems,
} from '@plein/plugin-sdk'

/** 平台按 data URL 的子类型认格式（只认 wav / mp3），MP3 的标准 MIME audio/mpeg 会被当成 .mpeg */
const AUDIO_FORMAT: Record<string, string> = {
  'audio/x-wav': 'audio/wav',
  'audio/mpeg': 'audio/mp3',
}

/** 素材类别的称呼；文案里要能看出是哪种素材 */
const LABELS = { image: '参考图片', video: '参考视频', audio: '参考音频' } as const

/**
 * 平台默认的参考素材要求。模型在 `limits.media` 里声明了要求时以模型声明为准，
 * 声明与这里的默认值是同一份规则的两种来源，运行期与运行前检查读的都是它。
 * 未声明平台的通用用法不做编码检查：那时拿不到可靠的编码信息。
 */
const platformRequirements = (platform: 'minimax' | 'ark' | undefined): MediaRequirements => {
  const ark = platform === 'ark'
  return {
    image: {
      mime: ark
        ? [
            'image/jpeg',
            'image/png',
            'image/webp',
            'image/bmp',
            'image/tiff',
            'image/gif',
            'image/heic',
            'image/heif',
          ]
        : ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
      maxMB: 30,
      ...(ark ? { maxMBExclusive: true } : {}),
      minEdge: ark ? 300 : 256,
      maxEdge: ark ? 6000 : 5760,
      minRatio: 0.4,
      maxRatio: 2.5,
    },
    video: {
      mime: ['video/mp4', 'video/quicktime'],
      maxMB: ark ? 200 : 50,
      minEdge: ark ? 300 : 256,
      maxEdge: ark ? 6000 : 5760,
      minRatio: 0.4,
      maxRatio: 2.5,
      ...(ark ? { minPixels: 407696, maxPixels: 8295044 } : {}),
      minDuration: 2,
      maxDuration: 15,
      totalDurationMax: 15,
      ...(platform
        ? {
            videoCodecs: ['h264', 'hevc'],
            minFrameRate: ark ? 24 : 23.976,
            maxFrameRate: 60,
            audioCodecs: ['aac', 'mp3'],
            ...(ark ? { pcmAudioMimes: ['video/quicktime'] } : {}),
          }
        : {}),
    },
    audio: {
      mime: ['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3'],
      maxMB: 15,
      minDuration: 2,
      maxDuration: 15,
      totalDurationMax: 15,
    },
  }
}

/** Encode local references through the host, never exposing a local path or secret URL. */
export async function videoReferences(
  refs: AssetRef[],
  ctx: Pick<ProviderContext, 'files'>,
  limits: {
    image: number
    video: number
    audio: number
    allowAudioOnly?: boolean
    platform?: 'minimax' | 'ark'
    /** 模型声明的素材要求；缺省时用平台默认 */
    requirements?: MediaRequirements
    /** 模型显示名，文案里要说清是哪个模型的要求 */
    title?: string
    /** 参考视频按哪种任务模式检查（如编辑参考视频的最短时长） */
    videoTask?: string
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
      throw new ProviderError(
        'invalid_input',
        '火山方舟本地视频参考需要配置视频参考存储（TOS 或 S3 兼容）',
      )
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
  const requirements = limits.requirements ?? platformRequirements(limits.platform)
  const title = limits.title ?? '当前模型'
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
    const kind = ref.kind as keyof typeof counts
    const label = LABELS[kind]
    if (!file.data.length) throw new ProviderError('invalid_input', `${label}不能是空文件`)
    // 与宿主运行前检查同一份声明：格式、大小、尺寸、时长、编码都在这里判。
    const problems = mediaRequirementProblems(
      mediaRequirementOf(requirements, kind, kind === 'video' ? limits.videoTask : undefined),
      {
        mime: file.mime,
        size: file.data.length,
        width: file.width,
        height: file.height,
        duration: file.duration,
        videoCodec: file.videoCodec,
        frameRate: file.frameRate,
        audioCodecs: file.audioCodecs,
      },
      { title, label, strict: true },
    )
    if (problems.length) throw new ProviderError('invalid_input', problems[0]!)
    if (kind !== 'image') {
      totals[kind] += file.duration ?? 0
      const total = mediaRequirementOf(requirements, kind)
      if (total?.totalDurationMax !== undefined && totals[kind] > total.totalDurationMax)
        throw new ProviderError(
          'invalid_input',
          `${label}总时长 ${totals[kind]} 秒，超过 ${title} 的 ${total.totalDurationMax} 秒上限，请缩短素材`,
        )
    }
    if (ark && kind === 'video') {
      uploads.push({ index: content.length, ref, file })
      content.push({ type: 'video_url', role: 'reference_video' })
      continue
    }
    const encoded = Buffer.from(file.data).toString('base64')
    bytes += encoded.length
    if (bytes > 63 * 1024 * 1024)
      throw new ProviderError('invalid_input', '参考素材编码后超过请求上限，请缩短或压缩素材')
    const type = `${kind}_url`
    const mime = file.mime.toLowerCase()
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
