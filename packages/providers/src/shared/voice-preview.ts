import type { ProviderContext } from '@plein/plugin-sdk'

/** 试听是已经创建的音色的附属结果，调用者须单独处理失败，不能重新创建音色。 */
export async function downloadVoicePreview(
  url: string,
  ctx: Pick<ProviderContext, 'fetch' | 'signal'>,
) {
  const response = await ctx.fetch(url, { signal: ctx.signal })
  const limit = 20 * 1024 * 1024
  if (!response.ok || !response.body) throw new Error('试听下载失败')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) throw new Error('试听文件过大')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  if (!size) throw new Error('试听为空')
  const bytes = Buffer.concat(chunks)
  const header = response.headers.get('content-type')?.split(';')[0]
  const signature = bytes.toString('ascii', 0, 4)
  const mime = header?.startsWith('audio/')
    ? header
    : signature === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE'
      ? 'audio/wav'
      : signature === 'OggS'
        ? 'audio/ogg'
        : signature === 'fLaC'
          ? 'audio/flac'
          : bytes.toString('ascii', 0, 3) === 'ID3' ||
              (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
            ? 'audio/mpeg'
            : undefined
  if (!mime) throw new Error('试听不是有效音频')
  return { data: new Uint8Array(bytes), mime }
}
