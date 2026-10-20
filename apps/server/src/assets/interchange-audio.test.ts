import { execFileSync, spawnSync } from 'node:child_process'
import { createReadStream, chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { bootServer, tempDir } from '../testing'
import { sequencePackage } from './interchange'
import { probeMedia, setMediaTools } from './media'

const tools = {
  ffmpeg: process.env.PLEIN_FFMPEG_PATH || 'ffmpeg',
  ffprobe: process.env.PLEIN_FFPROBE_PATH || 'ffprobe',
}
const available = Object.values(tools).every(
  (file) => spawnSync(file, ['-version'], { stdio: 'ignore' }).status === 0,
)
afterEach(() => setMediaTools({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }))
const ff = (...args: string[]) =>
  execFileSync(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...args])

function audio(dir: string, channels: number, rate: number) {
  const file = join(dir, `${channels}ch-${rate}.wav`)
  ff(
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=0.3',
    '-ar',
    String(rate),
    '-ac',
    String(channels),
    file,
  )
  return file
}

describe.skipIf(!available)('真实媒体探测与剪辑工程的音频源属性', () => {
  it.each([
    [1, 24000],
    [2, 48000],
  ])('单一音频流：%i 声道、%i Hz', async (channels, rate) => {
    setMediaTools(tools)
    const info = await probeMedia(audio(tempDir(), channels!, rate!))
    expect(info).toMatchObject({
      hasAudio: true,
      hasVideo: false,
      audioChannels: channels,
      audioSampleRate: rate,
    })
    expect(info.duration).toBeCloseTo(0.3, 2)
  })

  it('真实多音频流不取第一条或猜测合并后的声道、采样率', async () => {
    setMediaTools(tools)
    const dir = tempDir()
    const mono = audio(dir, 1, 24000)
    const stereo = audio(dir, 2, 48000)
    const file = join(dir, 'multiple.mka')
    ff('-i', mono, '-i', stereo, '-map', '0:a', '-map', '1:a', '-c:a', 'pcm_s16le', file)
    const raw = JSON.parse(
      execFileSync(tools.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', file], {
        encoding: 'utf8',
      }),
    )
    expect(
      raw.streams.filter((s: { codec_type: string }) => s.codec_type === 'audio'),
    ).toHaveLength(2)
    const info = await probeMedia(file)
    expect(info.hasAudio).toBe(true)
    expect(info).not.toHaveProperty('audioChannels')
    expect(info).not.toHaveProperty('audioSampleRate')
  })

  it('真实单声道/双声道事实透传到 ZIP，静音画面不写假的音频属性，README 不承诺 OTIO 应用私有音量', async () => {
    const dir = tempDir()
    const video = join(dir, 'silent.mp4')
    ff('-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=30:d=0.3', '-an', '-c:v', 'mpeg4', video)
    const { server } = await bootServer({
      config: { ffmpegPath: tools.ffmpeg, ffprobePath: tools.ffprobe },
    })
    const ingest = (file: string, mime: string, name: string) =>
      server.assets.ingest('local', createReadStream(file), { mime, name })
    const clip = await ingest(video, 'video/mp4', 'silent.mp4')
    const mono = await ingest(audio(dir, 1, 24000), 'audio/wav', 'mono.wav')
    const stereo = await ingest(audio(dir, 2, 48000), 'audio/wav', 'stereo.wav')
    const archive = await sequencePackage(server.assets, 'local', {
      name: 'audio-contract',
      width: 1920,
      height: 1080,
      fps: 30,
      clips: [{ asset: { assetId: clip.id, kind: 'video' }, in: 0, volume: 0 }],
      audio: [
        { asset: { assetId: mono.id, kind: 'audio' }, start: 0, volume: 1 },
        { asset: { assetId: stereo.id, kind: 'audio' }, start: 0, volume: 0.12, loop: true },
      ],
    })
    const chunks: Buffer[] = []
    for await (const chunk of archive.stream) chunks.push(Buffer.from(chunk))
    const files = unzipSync(Buffer.concat(chunks))
    const xml = strFromU8(files['audio-contract/timeline.fcpxml']!)
    const assets = xml.match(/<asset\s[^>]+>/g)!
    expect(assets.find((a) => a.includes('name="mono"'))).toContain(
      'audioChannels="1" audioRate="24000"',
    )
    expect(assets.find((a) => a.includes('name="stereo"'))).toContain(
      'audioChannels="2" audioRate="48000"',
    )
    expect(assets.find((a) => a.includes('name="silent"'))).not.toMatch(
      /audioChannels=|audioRate=|audioSources=/,
    )
    expect(xml).not.toContain('audioSources=')
    expect(xml).toMatch(/<sequence [^>]+audioRate="48k"/)
    const readme = strFromU8(files['audio-contract/README.txt']!)
    expect(readme).toContain('FCPXML 保留各轨声音的基础音量')
    expect(readme).toContain('OTIO 只把音量附在 plein 私有元数据中')
    expect(readme).toContain('导入后请核对并按需设置')
  })
})

function probeFixture(stream: Record<string, unknown>) {
  const dir = tempDir()
  const file = join(dir, 'ffprobe')
  writeFileSync(
    file,
    `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify({ streams: [stream], format: { duration: '0.3' } })}\nJSON\n`,
  )
  chmodSync(file, 0o755)
  setMediaTools({ ffmpeg: tools.ffmpeg, ffprobe: file })
  return probeMedia('unused')
}

it('声道和采样率各自已知时独立保留，不因另一项未知而抹去事实', async () => {
  const channels = await probeFixture({ codec_type: 'audio', channels: 1, sample_rate: 'N/A' })
  expect(channels.audioChannels).toBe(1)
  expect(channels).not.toHaveProperty('audioSampleRate')
  const rate = await probeFixture({ codec_type: 'audio', sample_rate: '24000' })
  expect(rate.audioSampleRate).toBe(24000)
  expect(rate).not.toHaveProperty('audioChannels')
})

it.each([
  [{ codec_type: 'audio' }],
  [{ codec_type: 'audio', channels: 0, sample_rate: 'N/A' }],
  [{ codec_type: 'audio', channels: 1.5, sample_rate: '-48000' }],
])('未知或非法音频属性省略，不补默认值：%j', async (stream) => {
  const info = await probeFixture(stream)
  expect(info.hasAudio).toBe(true)
  expect(info).not.toHaveProperty('audioChannels')
  expect(info).not.toHaveProperty('audioSampleRate')
})
