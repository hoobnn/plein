import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Asset, MediaDeriveRequest } from '@plein/protocol'
import sharp from 'sharp'
import { DeriveError } from './derive-error'
import { ffmpeg, h264Args, mediaCaps, probeMedia, videoPacketTimes, type Probe } from './media'
import type { AssetStore } from './store'

type Input = Extract<MediaDeriveRequest, { op: 'repair-region' | 'replace-range' }>

function videoInfo(probe: Probe, preserveSize = true) {
  const duration = probe.videoDuration ?? probe.duration
  if (!probe.hasVideo || !probe.width || !probe.height || !duration || !Number.isFinite(duration))
    throw new DeriveError('unsupported', '无法读取有效的视频尺寸与时长')
  if (preserveSize && (probe.width % 2 || probe.height % 2))
    throw new DeriveError('unsupported', '视频宽高须为偶数像素，才能保持原尺寸输出 H.264')
  return { width: probe.width, height: probe.height, duration }
}

function frameAt(seconds: number, fps: number, label: string) {
  const frame = Math.round(seconds * fps)
  if (!Number.isFinite(seconds) || seconds < 0 || Math.abs(seconds * fps - frame) > 0.0005)
    throw new DeriveError(
      'invalid',
      `${label}需对齐 ${Number(fps.toFixed(6))} fps 的帧边界，可填写 ${(frame / fps).toFixed(6)} 秒`,
    )
  return frame
}

export async function deriveAdvancedVideo(
  store: AssetStore,
  owner: string,
  source: Asset,
  input: Input,
  dir: string,
  name: string,
) {
  const original = store.originalPath(source.id)
  if (!existsSync(original)) throw new DeriveError('not_found', '原视频文件缺失，请先恢复素材')
  const probe = await probeMedia(original)
  const { width, height, duration } = videoInfo(probe)
  const out = join(dir, 'advanced.mp4')
  let params: Record<string, unknown>
  let note: string
  if (input.op === 'repair-region') {
    if (!(await mediaCaps()).regionRepair)
      throw new DeriveError('unsupported', '本机 ffmpeg 缺少 removelogo 滤镜，不能进行区域插值修补')
    const { left, top, width: regionWidth, height: regionHeight } = input
    if (
      ![left, top, regionWidth, regionHeight].every(Number.isSafeInteger) ||
      left < 1 ||
      top < 1 ||
      regionWidth < 1 ||
      regionHeight < 1 ||
      left + regionWidth >= width ||
      top + regionHeight >= height
    )
      throw new DeriveError(
        'invalid',
        `修补区域须在 ${width}×${height} 画面内，四周至少保留 1 像素背景`,
      )
    const start = input.start
    const end = input.end ?? duration
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > duration + 0.0001
    )
      throw new DeriveError('invalid', `修补区间须在 0–${duration.toFixed(6)} 秒内，且出点大于入点`)
    const mask = join(dir, 'region-mask.png')
    await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="black"/><rect x="${left}" y="${top}" width="${regionWidth}" height="${regionHeight}" fill="white"/></svg>`,
      ),
    )
      .flatten({ background: 'black' })
      .greyscale()
      .png()
      .toFile(mask)
    // 固定相对掩码名避免将文件路径里的冒号、引号带入滤镜表达式。
    const filter = `removelogo=filename=region-mask.png:enable='gte(t,${start})*lt(t,${end})'`
    await ffmpeg(
      [
        '-i',
        original,
        '-map',
        '0:V:0',
        '-map',
        '0:a?',
        '-vf',
        filter,
        ...(await h264Args()),
        '-c:a',
        'copy',
        '-map_metadata',
        '-1',
        '-metadata:s:v:0',
        'rotate=0',
        '-movflags',
        '+faststart',
        out,
      ],
      { cwd: dir },
    )
    params = {
      left,
      top,
      width: regionWidth,
      height: regionHeight,
      start,
      end,
      method: 'removelogo',
      audio: 'source',
    }
    note = '使用周边像素进行本地插值，复杂背景可能出现模糊或拖影；原音轨保留。'
  } else {
    const replacement = store.get(owner, input.replacementAssetId)
    if (!replacement || !existsSync(store.originalPath(input.replacementAssetId)))
      throw new DeriveError('not_found', '替换素材不存在或不属于当前用户')
    if (replacement.kind !== 'video') throw new DeriveError('unsupported', '替换素材必须是视频')
    const replacementFile = store.originalPath(replacement.id)
    const replacementProbe = await probeMedia(replacementFile)
    const replacementInfo = videoInfo(replacementProbe, false)
    const fps = probe.frameRate
    if (!fps || !Number.isFinite(fps) || fps <= 0 || fps > 240)
      throw new DeriveError('unsupported', '无法读取有效原视频帧率，不能精确替换时间段')
    if (!probe.nominalFrameRate || Math.abs(probe.nominalFrameRate - fps) > 0.00001)
      throw new DeriveError('unsupported', '片段替换需要固定帧率原视频；请先转换可变帧率素材')
    const totalFrames = frameAt(duration, fps, '原视频时长')
    const timestamps = await videoPacketTimes(original)
    const tolerance = Math.max(
      0.000002,
      Math.min(0.25 / fps, (probe.videoTimeBase ?? 0.000001) * 1.01),
    )
    if (
      !timestamps?.length ||
      timestamps.length !== totalFrames ||
      timestamps.some((at, i) => Math.abs(at - timestamps[0]! - i / fps) > tolerance)
    )
      throw new DeriveError(
        'unsupported',
        '原视频的实际帧时间戳不等距或无法在限额内核验，请先转换为固定帧率视频',
      )
    const first = frameAt(input.start, fps, '替换入点')
    const last = frameAt(input.end, fps, '替换出点')
    if (last <= first || last > totalFrames)
      throw new DeriveError('invalid', `替换区间须在 0–${duration.toFixed(6)} 秒内，且出点大于入点`)
    const count = last - first
    const length = count / fps
    if (
      !Number.isFinite(input.replacementStart) ||
      input.replacementStart < 0 ||
      input.replacementStart + length > replacementInfo.duration + 0.0001
    )
      throw new DeriveError(
        'invalid',
        `替换视频从 ${input.replacementStart} 秒起不足 ${length.toFixed(6)} 秒，不能自动补帧或拉伸`,
      )
    const filters: string[] = []
    const labels: string[] = []
    if (first > 0) {
      filters.push(`[0:v:0]trim=end_frame=${first},setpts=PTS-STARTPTS,setsar=1[before]`)
      labels.push('[before]')
    }
    filters.push(
      `[1:v:0]trim=start=${input.replacementStart}:duration=${length},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},trim=end_frame=${count},setpts=N/(${fps}*TB)[replacement]`,
    )
    labels.push('[replacement]')
    if (last < totalFrames) {
      filters.push(
        `[0:v:0]trim=start_frame=${last}:end_frame=${totalFrames},setpts=PTS-STARTPTS,setsar=1[after]`,
      )
      labels.push('[after]')
    }
    filters.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[video]`)
    await ffmpeg([
      '-i',
      original,
      '-i',
      replacementFile,
      '-filter_complex',
      filters.join(';'),
      '-map',
      '[video]',
      '-map',
      '0:a?',
      ...(await h264Args()),
      '-fps_mode',
      'passthrough',
      '-c:a',
      'copy',
      '-map_metadata',
      '-1',
      '-metadata:s:v:0',
      'rotate=0',
      '-movflags',
      '+faststart',
      out,
    ])
    params = {
      start: input.start,
      end: input.end,
      replacementAssetId: replacement.id,
      replacementStart: input.replacementStart,
      frameRate: fps,
      frames: count,
      audio: 'source',
      fit: 'contain',
    }
    note = '仅替换所选区间的画面，替换素材按原画幅留黑适配；原音轨保留，不使用替换素材的声音。'
  }
  const result = await probeMedia(out)
  if (
    !result.hasVideo ||
    result.width !== width ||
    result.height !== height ||
    Math.abs((result.videoDuration ?? result.duration ?? 0) - duration) > 0.002 ||
    (probe.duration !== undefined && Math.abs((result.duration ?? 0) - probe.duration) > 0.002) ||
    JSON.stringify(result.audioCodecs) !== JSON.stringify(probe.audioCodecs)
  )
    throw new DeriveError('unsupported', '加工结果未能保持原视频画幅与时长，未保存产物')
  return { files: [{ file: out, name: `${name}.mp4`, mime: 'video/mp4' }], params, note }
}
