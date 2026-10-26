import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Asset } from '@plein/protocol'
import sharp from 'sharp'
import { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test'
import { openDb } from '../storage/db'
import { tempDir } from '../testing'
import { deriveAsset, readOrigin } from './derive'
import { hasFfmpeg, probeMedia, setMediaTools } from './media'
import { mediaRoutes } from './media-routes'
import type { AuthEnv } from '../auth'
import { AssetStore } from './store'

const available = await hasFfmpeg()
const OWNER = 'local'
let store: AssetStore
let db: ReturnType<typeof openDb>
let source: Asset
let replacement: Asset
let foreign: Asset
let image: Asset
let longAudio: Asset
let variable: Asset
let misleadingRate: Asset
let dir: string

function video(
  file: string,
  seconds: number,
  color: string,
  frequency: number,
  size = '160x90',
  mark = false,
  audioSeconds = seconds,
) {
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=${size}:r=10:d=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:sample_rate=48000:duration=${audioSeconds}`,
    ...(mark ? ['-vf', 'drawbox=x=40:y=30:w=32:h=20:color=white:t=fill'] : []),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    file,
  ])
}
async function pixel(file: string, at: number, x = 56, y = 40) {
  const png = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-ss',
    String(at),
    '-i',
    file,
    '-frames:v',
    '1',
    '-f',
    'image2pipe',
    '-vcodec',
    'png',
    '-',
  ])
  const bytes = await sharp(png)
    .extract({ left: x, top: y, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer()
  return [...bytes]
}
const audioHash = (file: string) =>
  execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      file,
      '-map',
      '0:a:0',
      '-c:a',
      'copy',
      '-f',
      'hash',
      '-hash',
      'sha256',
      '-',
    ],
    { encoding: 'utf8' },
  )
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

beforeAll(async () => {
  if (!available) return
  dir = tempDir("plein advanced 'mask:")
  db = openDb(dir)
  store = new AssetStore(dir, db, 256 * 1024 * 1024)
  await store.init()
  const src = join(dir, 'source.mp4')
  const candidate = join(dir, 'replacement.mp4')
  const other = join(dir, 'foreign.mp4')
  video(src, 2, 'blue', 440, '160x90', true)
  video(candidate, 3, 'red', 880, '90x120')
  video(other, 0.3, 'green', 1100)
  const longFile = join(dir, 'long-audio.mp4')
  video(longFile, 2, 'blue', 440, '160x90', false, 3)
  longAudio = await store.ingest(OWNER, createReadStream(longFile), {
    mime: 'video/mp4',
    name: 'long-audio.mp4',
  })
  const variableFile = join(dir, 'variable.mp4')
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=blue:s=160x90:r=10:d=1',
    '-f',
    'lavfi',
    '-i',
    'color=blue:s=160x90:r=20:d=1',
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-fps_mode',
    'vfr',
    variableFile,
  ])
  variable = await store.ingest(OWNER, createReadStream(variableFile), {
    mime: 'video/mp4',
    name: 'variable.mp4',
  })
  const misleadingFile = join(dir, 'same-average-variable.mp4')
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=blue:s=160x90:r=10:d=2',
    '-vf',
    'setpts=if(eq(N\\,5)\\,PTS+1\\,PTS)',
    '-c:v',
    'libx264',
    '-fps_mode',
    'passthrough',
    '-video_track_timescale',
    '1000',
    misleadingFile,
  ])
  misleadingRate = await store.ingest(OWNER, createReadStream(misleadingFile), {
    mime: 'video/mp4',
    name: 'same-average-variable.mp4',
  })
  source = await store.ingest(OWNER, createReadStream(src), {
    mime: 'video/mp4',
    name: 'source.mp4',
  })
  replacement = await store.ingest(OWNER, createReadStream(candidate), {
    mime: 'video/mp4',
    name: 'candidate.mp4',
  })
  foreign = await store.ingest('other', createReadStream(other), {
    mime: 'video/mp4',
    name: 'foreign.mp4',
  })
  const picture = join(dir, 'picture.png')
  await sharp({ create: { width: 16, height: 16, channels: 3, background: 'black' } })
    .png()
    .toFile(picture)
  image = await store.ingest(OWNER, createReadStream(picture), {
    mime: 'image/png',
    name: 'picture.png',
  })
})
afterEach(() => setMediaTools({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }))
afterAll(() => db?.$client.close())

it('只读账号不能通过加工接口创建资产', async () => {
  const app = new Hono<AuthEnv>()
    .use('*', (c, next) => {
      c.set('principal', { id: OWNER, role: 'viewer' })
      return next()
    })
    .route('/', mediaRoutes(store))
  const response = await app.request('/api/media/derive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      op: 'repair-region',
      assetId: 'a'.repeat(64),
      left: 1,
      top: 1,
      width: 10,
      height: 10,
    }),
  })
  expect(response.status).toBe(403)
})

describe.skipIf(!available)('本地高级视频加工', () => {
  it('固定区域仅在选定时间内插值修补，保留尺寸、时长、音轨和原文件；路径支持引号与冒号', async () => {
    const original = store.originalPath(source.id)
    const before = hash(original)
    const result = await deriveAsset(store, OWNER, {
      op: 'repair-region',
      assetId: source.id,
      left: 36,
      top: 26,
      width: 40,
      height: 28,
      start: 0.5,
      end: 1.5,
    })
    const file = store.originalPath(result.assets[0]!.id)
    expect(await probeMedia(file)).toMatchObject({
      width: 160,
      height: 90,
      hasAudio: true,
      videoDuration: 2,
    })
    expect((await pixel(file, 0.2))[0]).toBeGreaterThan(180)
    const repaired = await pixel(file, 1)
    expect(repaired[2]).toBeGreaterThan(180)
    expect(repaired[0]).toBeLessThan(60)
    expect((await pixel(file, 1.8))[0]).toBeGreaterThan(180)
    expect(audioHash(file)).toBe(audioHash(original))
    expect(hash(original)).toBe(before)
    expect(result.note).toContain('插值')
    expect(await readOrigin(store, result.assets[0]!.id)).toMatchObject({
      op: 'repair-region',
      params: { left: 36, start: 0.5, end: 1.5, method: 'removelogo' },
    })
  }, 30000)

  it.each([
    [0.5, 1.5],
    [0, 1],
    [1, 2],
    [0, 2],
  ])(
    '替换 %s–%s 秒的画面，严格保留原时长与音轨且不采用候选声音',
    async (start, end) => {
      const original = store.originalPath(source.id)
      const result = await deriveAsset(store, OWNER, {
        op: 'replace-range',
        assetId: source.id,
        replacementAssetId: replacement.id,
        start,
        end,
        replacementStart: 0,
      })
      const file = store.originalPath(result.assets[0]!.id)
      expect(await probeMedia(file)).toMatchObject({
        width: 160,
        height: 90,
        videoDuration: 2,
        hasAudio: true,
      })
      const at = (start + end) / 2
      const middle = await pixel(file, at)
      expect(middle[0]).toBeGreaterThan(180)
      expect(middle[2]).toBeLessThan(60)
      // 竖向候选按原画幅留黑，不拉伸脸部。
      expect((await pixel(file, at, 5, 40)).every((channel) => channel < 35)).toBe(true)
      if (start > 0) expect((await pixel(file, start / 2, 10, 10))[2]).toBeGreaterThan(180)
      if (end < 2) expect((await pixel(file, (end + 2) / 2, 10, 10))[2]).toBeGreaterThan(180)
      expect(audioHash(file)).toBe(audioHash(original))
      expect(await readOrigin(store, result.assets[0]!.id)).toMatchObject({
        op: 'replace-range',
        params: { replacementAssetId: replacement.id, audio: 'source', start, end },
      })
    },
    30000,
  )

  it('不足长度、非帧边界、越界、其他用户及非视频替换素材均拒绝', async () => {
    const base = {
      op: 'replace-range' as const,
      assetId: source.id,
      replacementAssetId: replacement.id,
      start: 0.5,
      end: 1.5,
      replacementStart: 0,
    }
    await expect(deriveAsset(store, OWNER, { ...base, replacementStart: 2.8 })).rejects.toThrow(
      '不足',
    )
    await expect(deriveAsset(store, OWNER, { ...base, start: 0.55 })).rejects.toThrow('帧边界')
    await expect(deriveAsset(store, OWNER, { ...base, end: 2.1 })).rejects.toThrow('替换区间')
    await expect(
      deriveAsset(store, OWNER, { ...base, replacementAssetId: foreign.id }),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      deriveAsset(store, OWNER, { ...base, replacementAssetId: image.id }),
    ).rejects.toThrow('必须是视频')
  })

  it('视频短于原音轨时仍保留整条音轨与容器总时长，不被画面帧数截断', async () => {
    const made = await deriveAsset(store, OWNER, {
      op: 'replace-range',
      assetId: longAudio.id,
      replacementAssetId: replacement.id,
      start: 0.5,
      end: 1.5,
      replacementStart: 0,
    })
    const file = store.originalPath(made.assets[0]!.id)
    expect(await probeMedia(file)).toMatchObject({ videoDuration: 2, duration: 3 })
    expect(audioHash(file)).toBe(audioHash(store.originalPath(longAudio.id)))
  })

  it('不将可变帧率按平均帧率错误切分', async () => {
    await expect(
      deriveAsset(store, OWNER, {
        op: 'replace-range',
        assetId: variable.id,
        replacementAssetId: replacement.id,
        start: 0.5,
        end: 1,
        replacementStart: 0,
      }),
    ).rejects.toThrow('固定帧率')
  })

  it('平均与名义帧率均为10fps但实际PTS不等距时也拒绝替换', async () => {
    const observed = await probeMedia(store.originalPath(misleadingRate.id))
    expect(observed.frameRate).toBe(10)
    expect(observed.nominalFrameRate).toBe(10)
    await expect(
      deriveAsset(store, OWNER, {
        op: 'replace-range',
        assetId: misleadingRate.id,
        replacementAssetId: replacement.id,
        start: 0.5,
        end: 1,
        replacementStart: 0,
      }),
    ).rejects.toThrow('时间戳不等距')
  })

  it.skipIf(!existsSync('/Applications/Plein.app/Contents/Resources/ffmpeg/ffmpeg'))(
    '桌面VideoToolbox在拼接后保留末帧时长，不以音轨长度掩盖短一帧的视频',
    async () => {
      setMediaTools({
        ffmpeg: '/Applications/Plein.app/Contents/Resources/ffmpeg/ffmpeg',
        ffprobe: '/Applications/Plein.app/Contents/Resources/ffmpeg/ffprobe',
      })
      const made = await deriveAsset(store, OWNER, {
        op: 'replace-range',
        assetId: source.id,
        replacementAssetId: replacement.id,
        start: 0.5,
        end: 1.5,
        replacementStart: 0.2,
      })
      const file = store.originalPath(made.assets[0]!.id)
      expect(await probeMedia(file)).toMatchObject({ videoDuration: 2, duration: 2, frameRate: 10 })
      expect(audioHash(file)).toBe(audioHash(store.originalPath(source.id)))
      expect((await pixel(file, 1))[0]).toBeGreaterThan(180)
      expect((await pixel(file, 1.8, 10, 10))[2]).toBeGreaterThan(180)
    },
  )

  it('拒绝触边或越界的修补矩形和无效区间，缺少真实滤镜时明确不可用', async () => {
    const base = {
      op: 'repair-region' as const,
      assetId: source.id,
      left: 36,
      top: 26,
      width: 40,
      height: 28,
      start: 0,
      end: 2,
    }
    await expect(deriveAsset(store, OWNER, { ...base, left: 0 })).rejects.toThrow('四周')
    await expect(deriveAsset(store, OWNER, { ...base, width: 140 })).rejects.toThrow('四周')
    await expect(deriveAsset(store, OWNER, { ...base, start: 1.5, end: 1 })).rejects.toThrow(
      '修补区间',
    )
    const fake = join(dir, 'no-repair-ffmpeg')
    writeFileSync(
      fake,
      `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');if(process.argv.includes('-filters'))process.stdout.write(' T.. crop V->V\\n');else {const r=spawnSync('ffmpeg',process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1)}\n`,
    )
    chmodSync(fake, 0o755)
    setMediaTools({ ffmpeg: fake, ffprobe: 'ffprobe' })
    await expect(deriveAsset(store, OWNER, base)).rejects.toThrow('缺少 removelogo')
  })
})
