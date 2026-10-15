import { createReadStream, existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  Asset,
  AssetKind,
  MediaDerivation,
  MediaDeriveRequest,
  MediaOp,
} from '@plein/protocol'
import sharp from 'sharp'
import {
  atempoChain,
  audioSampleRate,
  audioTempoFilter,
  ffmpeg,
  fmtSeconds,
  hasFfmpeg,
  h264Args,
  mediaCaps,
  probeMedia,
  videoFrame,
  videoLastFrame,
} from './media'
import type { AssetStore } from './store'

/** 加工失败：带 code，HTTP 路由据此选状态码（invalid 参数、unsupported 类型不匹配） */
export class DeriveError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid' | 'unsupported' | 'no_ffmpeg',
    message: string,
  ) {
    super(message)
  }
}

/** 来源记录：产物 id 旁边存一份，源资产、坐标 / 区间、操作、参数都有，重启后仍可追溯 */
export interface DerivationOrigin {
  source: { assetId: string; kind: AssetKind; name: string }
  op: MediaOp
  params: Record<string, unknown>
  createdAt: number
}

function originPath(store: AssetStore, assetId: string) {
  return `${store.originalPath(assetId)}.derive.json`
}

/** 读某个资产加工时的来路；不是加工产物或记录已丢失时返回 null */
export async function readOrigin(
  store: AssetStore,
  assetId: string,
): Promise<DerivationOrigin | null> {
  try {
    return JSON.parse(await readFile(originPath(store, assetId), 'utf8')) as DerivationOrigin
  } catch {
    return null
  }
}

/** 中间产物与产物：文件路径 + 存进资产库时的文件名与类型 */
interface MadeFile {
  file: string
  name: string
  mime: string
}

interface Made {
  files: MadeFile[]
  params: Record<string, unknown>
  /** 能力降级等需要如实告知的话 */
  note?: string
}

const CONTAINER = ['-movflags', '+faststart']

const KIND_LABEL: Record<MediaOp, string> = {
  crop: '裁剪',
  rotate: '旋转',
  flip: '镜像',
  trim: '片段',
  speed: '变速',
  split: '切分',
  separate: '分离',
  frame: '帧',
}

const KIND_NAME: Record<AssetKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  file: '文件',
}

/** 文件名去掉扩展名，用来拼「片段-裁剪」这类名字 */
function stem(name: string) {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

/** 文件名会拼进临时路径，去掉路径分隔符和首尾空白 */
function safeName(name: string) {
  return name.replace(/[/\\]/g, '').trim() || '未命名'
}

function expectKind(src: Asset, op: MediaOp, kinds: AssetKind[]) {
  if (!kinds.includes(src.kind))
    throw new DeriveError(
      'unsupported',
      `${KIND_LABEL[op]}只支持${kinds.map((k) => KIND_NAME[k]).join('、')}，这个资产是${KIND_NAME[src.kind]}`,
    )
}

/** 区间合法性：正数、不倒挂、不超出素材时长（允许 0.05 秒的探测误差） */
function rangeOf(start: number, end: number, duration: number | undefined, what: string) {
  if (!(end > start)) throw new DeriveError('invalid', `${what}的出点要大于入点`)
  if (duration !== undefined && end > duration + 0.05)
    throw new DeriveError('invalid', `${what}超出素材长度（只有 ${duration.toFixed(1)} 秒）`)
  const to = duration === undefined ? end : Math.min(end, duration)
  // 入点本身就在素材末尾之后时，夹紧后长度会是负数，ffmpeg 只会报 -t 非法
  if (!(to > start))
    throw new DeriveError('invalid', `${what}的入点超出素材长度（只有 ${duration?.toFixed(1)} 秒）`)
  return { start, end: to, length: to - start }
}

/**
 * 把图片按 EXIF 方向摆正后落一份临时图。
 * 裁剪坐标是用户看到的像素，所以先摆正再裁；sharp 一次调用里 rotate / extract
 * 的先后并不直观，多一步中间文件换来坐标一定对得上。
 */
async function oriented(src: string, dir: string) {
  const out = join(dir, 'oriented.png')
  await sharp(src).rotate().png().toFile(out)
  return out
}

async function deriveImage(
  store: AssetStore,
  src: Asset,
  input: Extract<MediaDeriveRequest, { op: 'crop' | 'rotate' | 'flip' }>,
  dir: string,
): Promise<Made> {
  const base = await oriented(store.originalPath(src.id), dir)
  const meta = await sharp(base).metadata()
  const w = meta.width ?? 0
  const h = meta.height ?? 0
  // jpeg 源继续用 jpeg（体积小），其余走无损 png
  const jpeg = src.mime === 'image/jpeg'
  const ext = jpeg ? 'jpg' : 'png'
  const name = safeName(input.name?.trim() || `${stem(src.name)}-${KIND_LABEL[input.op]}`)
  const file = join(dir, `out.${ext}`)
  let pipeline = sharp(base)
  let params: Record<string, unknown>

  if (input.op === 'crop') {
    const { left, top, width, height } = input
    if (left + width > w || top + height > h)
      throw new DeriveError('invalid', `裁剪区域超出图片范围，这张图摆正后是 ${w}×${h}`)
    pipeline = pipeline.extract({ left, top, width, height })
    params = { left, top, width, height }
  } else if (input.op === 'rotate') {
    pipeline = pipeline.rotate(input.angle)
    params = { angle: input.angle }
  } else {
    pipeline = input.axis === 'horizontal' ? pipeline.flop() : pipeline.flip()
    params = { axis: input.axis }
  }
  await (jpeg ? pipeline.jpeg({ quality: 92 }) : pipeline.png()).toFile(file)
  return {
    files: [{ file, name: `${name}.${ext}`, mime: jpeg ? 'image/jpeg' : 'image/png' }],
    params,
  }
}

async function deriveVideo(
  store: AssetStore,
  src: Asset,
  input: Extract<MediaDeriveRequest, { op: 'trim' | 'speed' | 'separate' }>,
  dir: string,
): Promise<Made> {
  const srcFile = store.originalPath(src.id)
  const probe = await probeMedia(srcFile)
  const name = safeName(input.name?.trim() || `${stem(src.name)}-${KIND_LABEL[input.op]}`)
  const out = join(dir, 'out.mp4')
  const params: Record<string, unknown> = {}

  if (input.op === 'separate') {
    if (!probe.hasAudio) throw new DeriveError('unsupported', '这个视频没有音轨，不用分离')
    const audio = join(dir, 'out.m4a')
    // 一次跑出音轨与无声画面两个文件：重新编码，不靠 stream copy 免得容器对不上
    await ffmpeg([
      '-i',
      srcFile,
      '-map',
      '0:a',
      '-c:a',
      'aac',
      audio,
      '-map',
      '0:v',
      ...(await h264Args()),
      '-an',
      ...CONTAINER,
      out,
    ])
    return {
      files: [
        { file: audio, name: `${name}-音频.m4a`, mime: 'audio/mp4' },
        { file: out, name: `${name}-无声画面.mp4`, mime: 'video/mp4' },
      ],
      params,
    }
  }

  const args = ['-i', srcFile]
  if (input.op === 'trim') {
    const { start, length, end } = rangeOf(input.start, input.end, probe.duration, '截取区间')
    // -ss 放在 -i 前面是快速定位，配合 -t 限制长度；重编码保证入点精确
    args.unshift('-ss', fmtSeconds(start))
    args.push('-t', fmtSeconds(length))
    Object.assign(params, { start, end })
  } else {
    // 画面 setpts 拉伸、音轨 atempo 串联（同样是时间拉伸，音高不变），
    // 两条流各自变速后长度一致，所以不会音画不同步
    args.push('-filter:v', `setpts=${fmtSeconds(1 / input.speed)}*PTS`)
    if (probe.hasAudio) args.push('-filter:a', atempoChain(input.speed))
    args.push(...(await h264Args()))
    // setpts 只改 PTS 不会缩放最后一帧的时长，输出会多出约两帧画面（10fps 时有 0.2 秒），
    // 音轨就跟着短了。按时长兜个底，两条流才对得齐。
    if (probe.duration) args.push('-t', fmtSeconds(probe.duration / input.speed))
    Object.assign(params, { speed: input.speed, keepPitch: true })
  }
  if (probe.hasAudio) args.push('-c:a', 'aac')
  await ffmpeg([...args, ...CONTAINER, out])
  return { files: [{ file: out, name: `${name}.mp4`, mime: 'video/mp4' }], params }
}

async function deriveAudio(
  store: AssetStore,
  src: Asset,
  input: Extract<MediaDeriveRequest, { op: 'trim' | 'speed' | 'split' }>,
  dir: string,
): Promise<Made> {
  const srcFile = store.originalPath(src.id)
  const probe = await probeMedia(srcFile)
  const name = safeName(input.name?.trim() || `${stem(src.name)}-${KIND_LABEL[input.op]}`)
  const params: Record<string, unknown> = {}

  if (input.op === 'split') {
    // 手动切分：区间各不相同，各自跑一次 ffmpeg，产物按顺序返回
    const jobs = input.segments.map((seg, i) => {
      const { start, length } = rangeOf(seg.start, seg.end, probe.duration, `第 ${i + 1} 段`)
      const file = join(dir, `part-${i}.m4a`)
      return {
        file,
        args: [
          '-ss',
          fmtSeconds(start),
          '-i',
          srcFile,
          '-t',
          fmtSeconds(length),
          // mp3 常带专辑封面（视频流），带进 m4a 会直接失败
          '-vn',
          '-c:a',
          'aac',
          file,
        ],
      }
    })
    // 逐段跑：最多 20 段，并发起 20 个 ffmpeg 不划算；失败时也不会和清理临时目录赛跑
    for (const j of jobs) await ffmpeg(j.args)
    Object.assign(params, { segments: input.segments })
    return {
      files: jobs.map((j, i) => ({
        file: j.file,
        name: `${name}-${i + 1}.m4a`,
        mime: 'audio/mp4',
      })),
      params,
    }
  }

  const out = join(dir, 'out.m4a')
  const args = ['-i', srcFile]
  let note: string | undefined
  if (input.op === 'trim') {
    const { start, length, end } = rangeOf(input.start, input.end, probe.duration, '截取区间')
    args.unshift('-ss', fmtSeconds(start))
    args.push('-t', fmtSeconds(length), '-vn')
    Object.assign(params, { start, end })
  } else {
    const tempo = audioTempoFilter(input.speed, input.keepPitch, {
      rubberband: (await mediaCaps()).rubberband,
      sampleRate: await audioSampleRate(srcFile),
    })
    note = tempo.note
    args.push('-filter:a', tempo.filter, '-vn')
    Object.assign(params, { speed: input.speed, keepPitch: input.keepPitch })
  }
  await ffmpeg([...args, '-c:a', 'aac', out])
  return { files: [{ file: out, name: `${name}.m4a`, mime: 'audio/mp4' }], params, note }
}

/** 抽帧：任意时刻取一帧，落成图片资产，可以直接当参考图用 */
async function deriveFrame(
  store: AssetStore,
  src: Asset,
  input: Extract<MediaDeriveRequest, { op: 'frame' }>,
  dir: string,
): Promise<Made> {
  const srcFile = store.originalPath(src.id)
  const probe = await probeMedia(srcFile)
  const file = join(dir, 'frame.png')
  if (input.last) {
    const name = safeName(input.name?.trim() || `${stem(src.name)}-尾帧`)
    await videoLastFrame(srcFile, file)
    if (!existsSync(file)) throw new DeriveError('invalid', '这个视频取不到最后一帧')
    const at = probe.duration !== undefined ? Number(probe.duration.toFixed(2)) : undefined
    return {
      files: [{ file, name: `${name}.png`, mime: 'image/png' }],
      params: { last: true, ...(at !== undefined ? { at } : {}) },
    }
  }
  if (probe.duration !== undefined && input.at > probe.duration)
    throw new DeriveError('invalid', `取帧位置超出素材长度（只有 ${probe.duration.toFixed(1)} 秒）`)
  const name = safeName(input.name?.trim() || `${stem(src.name)}-${fmtSeconds(input.at)}s`)
  await videoFrame(srcFile, file, input.at)
  // 取在最后一帧之后（比如正好等于时长）时 ffmpeg 正常退出却不出图
  if (!existsSync(file)) throw new DeriveError('invalid', '这个时刻取不到画面，往前挪一点再试')
  return { files: [{ file, name: `${name}.png`, mime: 'image/png' }], params: { at: input.at } }
}

/**
 * 加工一个资产：产出新资产并记下来路，源资产一个字节都不动。
 * 前端工具条和智能体工具调的都是这一个函数，两条路不会出现两套实现。
 */
export async function deriveAsset(
  store: AssetStore,
  ownerId: string,
  input: MediaDeriveRequest,
): Promise<MediaDerivation> {
  const src = store.get(ownerId, input.assetId)
  if (!src) throw new DeriveError('not_found', '资产不存在')

  if (input.op === 'crop' || input.op === 'rotate' || input.op === 'flip') {
    expectKind(src, input.op, ['image'])
  } else if (input.op === 'split') {
    expectKind(src, input.op, ['audio'])
  } else if (input.op === 'separate' || input.op === 'frame') {
    expectKind(src, input.op, ['video'])
  } else {
    expectKind(src, input.op, ['video', 'audio'])
  }
  if (src.kind !== 'image' && !(await hasFfmpeg()))
    throw new DeriveError('no_ffmpeg', '本机没有 ffmpeg，无法加工视频 / 音频')

  const dir = await store.tempDir()
  try {
    let made: Made
    if (input.op === 'crop' || input.op === 'rotate' || input.op === 'flip') {
      made = await deriveImage(store, src, input, dir)
    } else if (input.op === 'frame') {
      made = await deriveFrame(store, src, input, dir)
    } else if (input.op === 'separate') {
      made = await deriveVideo(store, src, input, dir)
    } else if (input.op === 'split') {
      made = await deriveAudio(store, src, input, dir)
    } else if (src.kind === 'video') {
      made = await deriveVideo(store, src, input, dir)
    } else {
      made = await deriveAudio(store, src, input, dir)
    }

    const assets: Asset[] = []
    for (const f of made.files) {
      const asset = await store.ingest(ownerId, createReadStream(f.file), {
        mime: f.mime,
        name: f.name,
      })
      // 内容寻址下同样的产物会复用同一个 id，这里始终写最新的来路
      const origin: DerivationOrigin = {
        source: { assetId: src.id, kind: src.kind, name: src.name },
        op: input.op,
        params: made.params,
        createdAt: Date.now(),
      }
      await writeFile(originPath(store, asset.id), JSON.stringify(origin))
      assets.push(asset)
    }
    return {
      source: { assetId: src.id, kind: src.kind, name: src.name },
      op: input.op,
      params: made.params,
      assets,
      note: made.note,
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
