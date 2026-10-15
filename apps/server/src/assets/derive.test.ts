import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { API, type Asset } from '@plein/protocol'
import { strFromU8, unzipSync } from 'fflate'
import { Hono } from 'hono'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import type { AuthEnv } from '../auth'
import { mediaRoutes } from './media-routes'
import { openDb } from '../storage/db'
import { tempDir } from '../testing'
import { deriveAsset, readOrigin } from './derive'
import { atempoChain, audioTempoFilter, ffmpegBin, hasFfmpeg, mediaCaps } from './media'
import { AssetStore } from './store'

const OWNER = 'local'
const ffmpegAvailable = await hasFfmpeg()

// ── 测试素材：都在临时目录里现生成，不往仓库里放二进制 ──

/** 左红右蓝、左上角 4×4 绿色标记的图，用来验证坐标、旋转、镜像真的作用在像素上 */
async function genSplitImage(path: string, orientation?: number) {
  const w = 40
  const h = 20
  const data = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      const rgb = x < 4 && y < 4 ? [0, 255, 0] : x < w / 2 ? [255, 0, 0] : [0, 0, 255]
      data[i] = rgb[0]!
      data[i + 1] = rgb[1]!
      data[i + 2] = rgb[2]!
    }
  }
  let img = sharp(data, { raw: { width: w, height: h, channels: 3 } }).png()
  if (orientation) img = img.withMetadata({ orientation })
  await img.toFile(path)
}

function genVideo(path: string, seconds: number, fps = 25) {
  execFileSync(
    ffmpegBin(),
    [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=320x180:rate=${fps}:duration=${seconds}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      path,
    ],
    { stdio: 'pipe' },
  )
}

function genAudio(path: string, seconds: number) {
  execFileSync(
    ffmpegBin(),
    [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      '-c:a',
      'aac',
      path,
    ],
    { stdio: 'pipe' },
  )
}

// ── 断言辅助 ──

/** 某个像素的 RGB */
async function pixel(file: string, x: number, y: number) {
  const { data } = await sharp(file)
    .extract({ left: x, top: y, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true })
  return [...data.slice(0, 3)]
}

/** 颜色断言留一点余量：jpeg 源摆正后再裁是二次编码，纯色也会差一两个值 */
function isRed(rgb: number[]) {
  return rgb[0]! > 200 && rgb[1]! < 60 && rgb[2]! < 60
}
function isBlue(rgb: number[]) {
  return rgb[2]! > 200 && rgb[0]! < 60 && rgb[1]! < 60
}
function isGreen(rgb: number[]) {
  return rgb[1]! > 200 && rgb[0]! < 60 && rgb[2]! < 60
}

/** 各流自己的时长：验证变速之后音画没有跑开 */
function streamDurations(file: string) {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', file],
    { encoding: 'utf8' },
  )
  const streams = (JSON.parse(out) as { streams?: Array<Record<string, string>> }).streams ?? []
  const pick = (type: string) => Number(streams.find((s) => s.codec_type === type)?.duration ?? 0)
  return { video: pick('video'), audio: pick('audio') }
}

const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

function expectDuration(actual: number | undefined, seconds: number, tol = 0.25) {
  expect(actual).toBeDefined()
  expect(Math.abs(actual! - seconds)).toBeLessThan(tol)
}

// ── 共用环境 ──

let store: AssetStore
let db: ReturnType<typeof openDb>
let video: Asset
let audio: Asset
let image: Asset
let orientedImage: Asset
let lowFps: Asset

beforeAll(async () => {
  const dir = tempDir('plein-derive-')
  db = openDb(dir)
  store = new AssetStore(dir, db, 256 * 1024 * 1024)
  await store.init()

  const files = {
    video: join(dir, 'src.mp4'),
    audio: join(dir, 'src.m4a'),
    image: join(dir, 'src.png'),
    exif: join(dir, 'src-exif.jpg'),
    lowFps: join(dir, 'src-10fps.mp4'),
  }
  await genSplitImage(files.image)
  await genSplitImage(files.exif, 6)
  const put = (file: string, mime: string, name: string) =>
    store.ingest(OWNER, createReadStream(file), { mime, name })
  image = await put(files.image, 'image/png', '分色.png')
  orientedImage = await put(files.exif, 'image/jpeg', '带方向.jpg')
  if (ffmpegAvailable) {
    genVideo(files.video, 4)
    genVideo(files.lowFps, 2, 10)
    genAudio(files.audio, 6)
    video = await put(files.video, 'video/mp4', '原片.mp4')
    lowFps = await put(files.lowFps, 'video/mp4', '低帧率.mp4')
    audio = await put(files.audio, 'audio/mp4', '原声.m4a')
  }
})

afterAll(() => db.$client.close())

describe('图片加工', () => {
  it('裁剪：矩形坐标对应实际像素，超出范围给可读错误', async () => {
    const made = await deriveAsset(store, OWNER, {
      op: 'crop',
      assetId: image.id,
      left: 20,
      top: 0,
      width: 20,
      height: 20,
    })
    const file = store.originalPath(made.assets[0]!.id)
    expect(await sharp(file).metadata()).toMatchObject({ width: 20, height: 20 })
    // 右半边是蓝色：坐标没跑偏
    expect(isBlue(await pixel(file, 10, 10))).toBe(true)

    await expect(
      deriveAsset(store, OWNER, {
        op: 'crop',
        assetId: image.id,
        left: 30,
        top: 0,
        width: 20,
        height: 20,
      }),
    ).rejects.toThrow(/超出图片范围/)
  })

  it('裁剪按 EXIF 摆正后的像素算：orientation 6 的图显示为 20×40', async () => {
    expect(orientedImage).toMatchObject({ width: 20, height: 40 })
    const made = await deriveAsset(store, OWNER, {
      op: 'crop',
      assetId: orientedImage.id,
      left: 0,
      top: 0,
      width: 20,
      height: 20,
    })
    const file = store.originalPath(made.assets[0]!.id)
    expect(await sharp(file).metadata()).toMatchObject({ width: 20, height: 20 })
    // 顺时针摆正后左上角来自原图左下角（红），原图左上角的绿色标记跑到右上角
    expect(isRed(await pixel(file, 1, 1))).toBe(true)
    expect(isGreen(await pixel(file, 18, 1))).toBe(true)

    // 显示尺寸之外不能再裁
    await expect(
      deriveAsset(store, OWNER, {
        op: 'crop',
        assetId: orientedImage.id,
        left: 10,
        top: 0,
        width: 20,
        height: 20,
      }),
    ).rejects.toThrow(/超出图片范围/)
  })

  it('旋转与镜像：宽高与像素都跟着变', async () => {
    const rotated = await deriveAsset(store, OWNER, {
      op: 'rotate',
      assetId: image.id,
      angle: 90,
    })
    const rFile = store.originalPath(rotated.assets[0]!.id)
    expect(await sharp(rFile).metadata()).toMatchObject({ width: 20, height: 40 })
    // 顺时针 90°：原来的左半边（红）变成上半边
    expect(isRed(await pixel(rFile, 10, 5))).toBe(true)
    expect(isBlue(await pixel(rFile, 10, 35))).toBe(true)
    // 90° 的宽高和源资产对调，预览才不会拉伸
    expect(rotated.assets[0]).toMatchObject({ width: 20, height: 40 })

    const flipped = await deriveAsset(store, OWNER, {
      op: 'flip',
      assetId: image.id,
      axis: 'horizontal',
    })
    const fFile = store.originalPath(flipped.assets[0]!.id)
    expect(await sharp(fFile).metadata()).toMatchObject({ width: 40, height: 20 })
    expect(isBlue(await pixel(fFile, 5, 10))).toBe(true)
    expect(isRed(await pixel(fFile, 35, 10))).toBe(true)
  })

  it('裁剪结果记录了坐标，源图没有来路记录', async () => {
    const made = await deriveAsset(store, OWNER, {
      op: 'crop',
      assetId: image.id,
      left: 0,
      top: 0,
      width: 10,
      height: 10,
    })
    expect(await readOrigin(store, made.assets[0]!.id)).toMatchObject({
      source: { assetId: image.id, kind: 'image', name: '分色.png' },
      op: 'crop',
      params: { left: 0, top: 0, width: 10, height: 10 },
    })
    expect(await readOrigin(store, image.id)).toBeNull()
  })
})

describe('变速滤镜', () => {
  it('atempo 单级只到 2 倍，超出时串联', () => {
    expect(atempoChain(3)).toBe('atempo=2,atempo=1.5')
    expect(atempoChain(4)).toBe('atempo=2,atempo=2')
    expect(atempoChain(0.25)).toBe('atempo=0.5,atempo=0.5')
    expect(atempoChain(1.5)).toBe('atempo=1.5')
  })

  it('保音调优先 rubberband，没有时退到 atempo 并说明；不保音调改采样率', () => {
    const opts = { sampleRate: 48000 }
    expect(audioTempoFilter(2, true, { ...opts, rubberband: true })).toEqual({
      filter: 'rubberband=tempo=2',
    })
    const fallback = audioTempoFilter(2, true, { ...opts, rubberband: false })
    expect(fallback.filter).toBe('atempo=2')
    expect(fallback.note).toMatch(/rubberband/)
    // asetrate 让音高随速度一起变
    expect(audioTempoFilter(2, false, { ...opts, rubberband: true }).filter).toBe(
      'asetrate=96000,aresample=48000',
    )
  })
})

describe.skipIf(!ffmpegAvailable)('视频与音频加工', () => {
  it('抽帧：任意时刻落成图片资产，可以当参考图用', async () => {
    const made = await deriveAsset(store, OWNER, { op: 'frame', assetId: video.id, at: 2 })
    const asset = made.assets[0]!
    expect(asset).toMatchObject({ kind: 'image', mime: 'image/png', width: 320, height: 180 })
    expect(asset.variants).toContain('thumb-1024')
    expect(made.params).toEqual({ at: 2 })
    // 确实是视频里的画面，不是空白帧
    const { data } = await sharp(store.originalPath(asset.id))
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect(new Set(data).size).toBeGreaterThan(4)

    await expect(
      deriveAsset(store, OWNER, { op: 'frame', assetId: video.id, at: 99 }),
    ).rejects.toThrow(/超出素材长度/)
  })

  it('取尾帧：不用知道时长，落成图片资产并记下是尾帧', async () => {
    const made = await deriveAsset(store, OWNER, {
      op: 'frame',
      assetId: video.id,
      at: 0,
      last: true,
    })
    const asset = made.assets[0]!
    expect(asset).toMatchObject({ kind: 'image', mime: 'image/png', width: 320, height: 180 })
    expect(asset.name).toMatch(/尾帧\.png$/)
    expect(made.params.last).toBe(true)
    const first = await deriveAsset(store, OWNER, { op: 'frame', assetId: video.id, at: 0 })
    // 和第一帧不是同一张图
    expect(first.assets[0]!.id).not.toBe(asset.id)
  })

  it('视频截取：时长就是区间长度，源视频一个字节都没动', async () => {
    const before = hash(store.originalPath(video.id))
    const made = await deriveAsset(store, OWNER, {
      op: 'trim',
      assetId: video.id,
      start: 1,
      end: 3,
    })
    const asset = made.assets[0]!
    expectDuration(asset.duration, 2)
    expectDuration(streamDurations(store.originalPath(asset.id)).audio, 2)
    expect(made.params).toEqual({ start: 1, end: 3 })
    expect(hash(store.originalPath(video.id))).toBe(before)

    await expect(
      deriveAsset(store, OWNER, { op: 'trim', assetId: video.id, start: 3, end: 1 }),
    ).rejects.toThrow(/出点要大于入点/)
    await expect(
      deriveAsset(store, OWNER, { op: 'trim', assetId: video.id, start: 0, end: 99 }),
    ).rejects.toThrow(/超出素材长度/)
  })

  it('视频变速：setpts 与 atempo 同步处理，音画不跑开', async () => {
    for (const speed of [0.5, 2, 3]) {
      const made = await deriveAsset(store, OWNER, {
        op: 'speed',
        assetId: video.id,
        speed,
        keepPitch: true,
      })
      const asset = made.assets[0]!
      expectDuration(asset.duration, 4 / speed, 0.3)
      const { video: v, audio: a } = streamDurations(store.originalPath(asset.id))
      expect(a).toBeGreaterThan(0)
      // 两条流各自变速，长度必须一致，否则播起来音画会错位
      expect(Math.abs(v - a)).toBeLessThan(0.12)
    }
  })

  it('低帧率素材变速也不会拖尾：setpts 多出的那两帧要被截掉', async () => {
    // setpts 只改 PTS 不改最后一帧的时长，10fps 时会多出 0.2 秒画面
    const made = await deriveAsset(store, OWNER, {
      op: 'speed',
      assetId: lowFps.id,
      speed: 2,
      keepPitch: true,
    })
    const { video: v, audio: a } = streamDurations(store.originalPath(made.assets[0]!.id))
    expect(Math.abs(v - a)).toBeLessThan(0.12)
    expectDuration(made.assets[0]!.duration, 1, 0.12)
  })

  it('音视频分离：出来音频与无声视频两个资产', async () => {
    const made = await deriveAsset(store, OWNER, { op: 'separate', assetId: video.id })
    expect(made.assets).toHaveLength(2)
    const [audioOut, videoOut] = made.assets as [Asset, Asset]
    expect(audioOut).toMatchObject({ kind: 'audio' })
    expectDuration(audioOut.duration, 4)
    expect(videoOut).toMatchObject({ kind: 'video' })
    expectDuration(videoOut.duration, 4)
    const streams = streamDurations(store.originalPath(videoOut.id))
    expect(streams.audio).toBe(0)
    expect(streams.video).toBeGreaterThan(3)
    // 两个产物都记着来路
    for (const a of made.assets)
      expect(await readOrigin(store, a.id)).toMatchObject({
        source: { assetId: video.id, kind: 'video', name: '原片.mp4' },
        op: 'separate',
      })
  })

  it('音频：截取 / 手动切分 / 保音调变速都是本地工具', async () => {
    const trimmed = await deriveAsset(store, OWNER, {
      op: 'trim',
      assetId: audio.id,
      start: 1,
      end: 4,
    })
    expect(trimmed.assets[0]).toMatchObject({ kind: 'audio' })
    expectDuration(trimmed.assets[0]!.duration, 3)

    const split = await deriveAsset(store, OWNER, {
      op: 'split',
      assetId: audio.id,
      segments: [
        { start: 0, end: 2 },
        { start: 2, end: 4 },
        { start: 4, end: 6 },
      ],
    })
    expect(split.assets).toHaveLength(3)
    for (const a of split.assets) expectDuration(a.duration, 2)
    expect(split.params.segments).toHaveLength(3)

    // 保音调变速走本地 ffmpeg 滤镜，和 TTS 的 speed 参数无关
    const caps = await mediaCaps()
    const fast = await deriveAsset(store, OWNER, {
      op: 'speed',
      assetId: audio.id,
      speed: 2,
      keepPitch: true,
    })
    expectDuration(fast.assets[0]!.duration, 3)
    const slow = await deriveAsset(store, OWNER, {
      op: 'speed',
      assetId: audio.id,
      speed: 0.5,
      keepPitch: true,
    })
    expectDuration(slow.assets[0]!.duration, 12)
    if (caps.rubberband) expect(fast.note).toBeUndefined()
    // 没有 rubberband 时退到 atempo，必须如实说明它不是完美保音调
    else expect(fast.note).toMatch(/rubberband/)
  }, 30_000)

  it('加工结果能进入导出：新资产是完整可用的资产', async () => {
    const made = await deriveAsset(store, OWNER, {
      op: 'trim',
      assetId: video.id,
      start: 0,
      end: 2,
    })
    const asset = made.assets[0]!
    expect(store.get(OWNER, asset.id)).toMatchObject({ id: asset.id, kind: 'video' })
    expect(asset.variants).toContain('poster')
  })
})

// 图片加工只靠 sharp：没有 ffmpeg 的机器也要跑
describe('媒体加工接口', () => {
  // 身份由 requireAuth 注入，这里直接给定，加工只能碰自己名下的资产
  const app = (principal = OWNER) => {
    const server = new Hono<AuthEnv>()
    server.use('*', async (c, next) => {
      c.set('principal', { id: principal, role: 'owner' })
      await next()
    })
    server.route('/', mediaRoutes(store))
    return server
  }
  const post = (body: unknown, principal = OWNER) =>
    app(principal).request('/api/media/derive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('加工成功返回 201 与新资产', async () => {
    const res = await post({
      op: 'crop',
      assetId: image.id,
      left: 0,
      top: 0,
      width: 10,
      height: 10,
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { op: string; assets: Asset[]; source: { assetId: string } }
    expect(body.op).toBe('crop')
    expect(body.source.assetId).toBe(image.id)
    expect(body.assets[0]!.id).not.toBe(image.id)
    expect(await readOrigin(store, body.assets[0]!.id)).toMatchObject({ op: 'crop' })
  })

  it('只认自己的资产：别人的 id 与不存在的 id 都是 404', async () => {
    expect(
      (await post({ op: 'rotate', assetId: image.id, angle: 90 }, 'someone-else')).status,
    ).toBe(404)
    expect((await post({ op: 'rotate', assetId: 'f'.repeat(64), angle: 90 })).status).toBe(404)
  })

  it('参数不合法 400，并说明是哪一项', async () => {
    expect((await post({ op: 'nope', assetId: image.id })).status).toBe(400)
    expect((await post({ op: 'rotate', assetId: 'xyz', angle: 90 })).status).toBe(400)
    // 参数先于资产类型校验
    expect((await post({ op: 'speed', assetId: image.id, speed: 9 })).status).toBe(400)
    expect((await post({ op: 'split', assetId: image.id, segments: [] })).status).toBe(400)
    const res = await post({ op: 'rotate', assetId: image.id, angle: 45 })
    expect(((await res.json()) as { message: string }).message).toMatch(/angle/)
  })

  it('加工与素材类型不匹配 422，坐标越界 400', async () => {
    expect((await post({ op: 'separate', assetId: image.id })).status).toBe(422)
    const res = await post({
      op: 'crop',
      assetId: image.id,
      left: 0,
      top: 0,
      width: 999,
      height: 10,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { message: string }).message).toMatch(/超出图片范围/)
  })

  it.runIf(ffmpegAvailable)('视频不能按图片裁剪 422', async () => {
    expect(
      (await post({ op: 'crop', assetId: video.id, left: 0, top: 0, width: 1, height: 1 })).status,
    ).toBe(422)
  })

  it('能力查询返回本机 ffmpeg 能力', async () => {
    const res = await app().request('/api/media/caps')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ffmpeg: ffmpegAvailable })
  })
})

describe.skipIf(!ffmpegAvailable)('剪辑时间线的按需衍生物', () => {
  it('胶片条：16 帧等宽横拼，第一次请求时生成并记进资产', async () => {
    expect(video.variants).not.toContain('filmstrip')
    expect(await store.ensureVariant(video, 'filmstrip')).toBe(true)
    const meta = await sharp(store.variantPath(video.id, 'filmstrip')).metadata()
    // 320×180 缩到 90 高是 160 宽
    expect([meta.width, meta.height]).toEqual([160 * 16, 90])
    expect(store.get(OWNER, video.id)!.variants).toContain('filmstrip')
    // 音频没有胶片条
    expect(await store.ensureVariant(audio, 'filmstrip')).toBe(false)
  }, 30_000)

  it('峰值：每秒 100 个，正弦波接近满幅', async () => {
    expect(await store.ensureVariant(audio, 'peaks')).toBe(true)
    const { rate, peaks } = JSON.parse(
      readFileSync(store.variantPath(audio.id, 'peaks'), 'utf8'),
    ) as { rate: number; peaks: number[] }
    expect(rate).toBe(100)
    expect(Math.abs(peaks.length - 600)).toBeLessThan(10)
    expect(Math.max(...peaks.slice(10, 500))).toBeGreaterThan(0.05)
    // 视频自带的声音也能出峰值，图片不能
    expect(await store.ensureVariant(video, 'peaks')).toBe(true)
    expect(await store.ensureVariant(image, 'peaks')).toBe(false)
  }, 30_000)
})

describe.skipIf(!ffmpegAvailable)('剪辑工程导出', () => {
  const app = (principal = OWNER) => {
    const server = new Hono<AuthEnv>()
    server.use('*', async (c, next) => {
      c.set('principal', { id: principal, role: 'owner' })
      await next()
    })
    server.route('/', mediaRoutes(store))
    return server
  }
  const spec = () => ({
    width: 1080,
    height: 1920,
    fps: 30,
    name: '雨夜/归来',
    clips: [
      { asset: { assetId: video.id, kind: 'video' }, in: 0, out: 3, volume: 1 },
      {
        asset: { assetId: video.id, kind: 'video' },
        in: 1,
        out: 4,
        volume: 1,
        transition: { type: 'dissolve', duration: 0.5 },
      },
    ],
    audio: [{ asset: { assetId: audio.id, kind: 'audio' }, start: 0, volume: 0.3, loop: true }],
    subtitles: { cues: [{ start: 0, end: 1, text: '你来了' }], style: 'standard' },
  })

  it('打包 OTIO、FCPXML、字幕、说明和素材；链接只给本人用', async () => {
    const res = await app().request(API.sequenceExport, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: spec() }),
    })
    expect(res.status).toBe(201)
    const { url } = (await res.json()) as { url: string }
    expect((await app('someone-else').request(url)).status).toBe(404)
    const file = await app().request(url)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-disposition')).toContain(encodeURIComponent('雨夜_归来.zip'))
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
    expect(Object.keys(entries).sort()).toEqual([
      '雨夜_归来/README.txt',
      '雨夜_归来/media/01 原片.mp4',
      '雨夜_归来/media/02 原声.m4a',
      '雨夜_归来/subtitles.srt',
      '雨夜_归来/timeline.fcpxml',
      '雨夜_归来/timeline.otio',
    ])
    // 素材原样存进去
    expect(entries['雨夜_归来/media/01 原片.mp4']!.length).toBe(video.size)
    const otio = JSON.parse(strFromU8(entries['雨夜_归来/timeline.otio']!))
    expect(otio.tracks.children[0].children[1].OTIO_SCHEMA).toBe('Transition.1')
  })

  it('别人的素材当作不存在', async () => {
    const res = await app('someone-else').request(API.sequenceExport, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: spec() }),
    })
    expect(res.status).toBe(404)
  })
})
