import { compositionAssetIds } from '@plein/doc'
import { createReadStream } from 'node:fs'
import { extname } from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import { once } from 'node:events'
import {
  type InterchangeMedia,
  sequenceFcpxml,
  sequenceOtio,
  subtitleSrt,
  sequenceSourceMap,
} from '@plein/nodes'
import type { ComposeSpec } from '@plein/plugin-sdk'
import { strToU8, Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import { probeMedia } from './media'
import type { AssetStore } from './store'

const MIME_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
}

/** 文件名里不能有的字符（含控制字符）换成下划线，太长的截断 */
export const safeName = (name: string) =>
  name
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, '_')
    .trim()
    .slice(0, 60) || '未命名'

const README = `这个文件夹是 plein 导出的剪辑工程，素材在 media/ 里，工程用相对路径引用它们。
先把整个文件夹解压到想放的位置，再导入：

- DaVinci Resolve：文件 → 导入 → 时间线，选 timeline.otio（或 timeline.fcpxml）
- Final Cut Pro：文件 → 导入 → XML，选 timeline.fcpxml；提示素材离线时用「重新链接文件」指到 media/
- Kdenlive 等支持 OpenTimelineIO 的软件：导入 timeline.otio
- 字幕：subtitles.srt，大多数剪辑软件都能直接导入
- 动态合成：sources/ 保留对应源工程和冻结参数；动画在剪辑工程中为渲染视频，继续编辑请打开source.zip内的HTML工程

和 plein 导出的成片相比：
- 画面顺序、入出点、速度、重叠转场（叠化 / 划像 / 推移 / 闪白）和各轨声音的位置保留；
  FCPXML 里划像、推移、闪白统一用交叉叠化，经黑场转场在两个工程里都是硬切
- FCPXML 保留各轨声音的基础音量；OTIO 只把音量附在 plein 私有元数据中，剪辑软件不一定应用，导入后请核对并按需设置
- 对白时压低配乐、结尾淡出、响度标准化不保留（各软件的自动化格式不通用），需要时在剪辑软件里重做
`

/**
 * 打包剪辑工程：OTIO、FCPXML、SRT、说明和用到的全部素材，流式写成 zip（素材不压缩，原样存进去）。
 * 资产都按 ownerId 查，不是自己的资产当作不存在。
 */
export async function sequencePackage(
  store: AssetStore,
  ownerId: string,
  spec: ComposeSpec,
): Promise<{ stream: Readable; name: string }> {
  const refs = [...spec.clips.map((c) => c.asset), ...spec.audio.map((a) => a.asset)]
  const media = new Map<string, InterchangeMedia & { file: string }>()
  const used = new Set<string>()
  const sources = new Map<string, { bundle: string; manifest: string }>()
  for (const ref of refs) {
    const source = ref.compositionSource
    if (!source || sources.has(source.bundleAssetId)) continue
    for (const id of compositionAssetIds(source)) {
      try {
        await store.verifyOriginal(ownerId, id)
      } catch {
        throw Object.assign(new Error('动态合成源工程或原素材缺失或损坏'), { code: 'not_found' })
      }
    }
    sources.set(source.bundleAssetId, {
      bundle: store.originalPath(source.bundleAssetId),
      manifest: store.originalPath(source.manifestAssetId),
    })
  }
  for (const ref of refs) {
    if (media.has(ref.assetId)) continue
    const asset = store.get(ownerId, ref.assetId)
    if (!asset) throw Object.assign(new Error('素材不存在'), { code: 'not_found' })
    const file = store.originalPath(asset.id)
    const info = await probeMedia(file)
    const ext =
      MIME_EXT[asset.mime] ?? (extname(asset.name).slice(1) || asset.mime.split('/')[1] || 'bin')
    const base = safeName(asset.name.replace(/\.[^.]+$/, ''))
    let path = `media/${String(media.size + 1).padStart(2, '0')} ${base}.${ext}`
    while (used.has(path)) path = path.replace(/(\.[^.]+)$/, '_$1')
    used.add(path)
    media.set(asset.id, {
      file,
      path,
      name: base,
      duration:
        asset.kind === 'image'
          ? Math.max(
              0,
              ...spec.clips.filter((c) => c.asset.assetId === asset.id).map((c) => c.out ?? 1),
            )
          : (info.duration ?? asset.duration ?? 0),
      hasVideo: info.hasVideo,
      hasAudio: info.hasAudio,
      audioChannels: info.audioChannels,
      audioSampleRate: info.audioSampleRate,
    })
  }
  const lookup = (ref: { assetId: string }) => media.get(ref.assetId)!
  const name = safeName(spec.name ?? '序列')
  const texts: Array<[string, string]> = [
    ['timeline.otio', sequenceOtio(spec, lookup)],
    ['timeline.fcpxml', sequenceFcpxml(spec, lookup)],
    ['README.txt', README],
    [
      'clip-map.json',
      JSON.stringify(
        {
          version: 1,
          basis: 'executed-sequence-spec',
          fps: spec.fps,
          sources: sequenceSourceMap(spec),
        },
        null,
        2,
      ) + '\n',
    ],
  ]
  if (spec.subtitles?.cues.length) texts.push(['subtitles.srt', subtitleSrt(spec.subtitles.cues)])

  const out = new PassThrough()
  const controller = new AbortController()
  const zip = new Zip((err, data, final) => {
    if (out.destroyed) return
    if (err) out.destroy(err)
    else {
      out.write(data)
      if (final) out.end()
    }
  })
  out.once('close', () => {
    controller.abort()
    zip.terminate()
  })
  void (async () => {
    for (const [path, text] of texts) {
      const entry = new ZipDeflate(`${name}/${path}`, { level: 6 })
      zip.add(entry)
      entry.push(strToU8(text), true)
    }
    for (const [index, source] of [...sources.values()].entries()) {
      for (const [suffix, file] of [
        ['source.zip', source.bundle],
        ['manifest.json', source.manifest],
      ]) {
        controller.signal.throwIfAborted()
        const entry = new ZipPassThrough(`${name}/sources/${index + 1}/${suffix}`)
        zip.add(entry)
        for await (const chunk of createReadStream(file!, { signal: controller.signal })) {
          entry.push(chunk as Uint8Array)
          if (out.writableNeedDrain) await once(out, 'drain', { signal: controller.signal })
        }
        entry.push(new Uint8Array(0), true)
      }
    }
    for (const m of media.values()) {
      controller.signal.throwIfAborted()
      const entry = new ZipPassThrough(`${name}/${m.path}`)
      zip.add(entry)
      for await (const chunk of createReadStream(m.file, { signal: controller.signal })) {
        entry.push(chunk as Uint8Array)
        if (out.writableNeedDrain) await once(out, 'drain', { signal: controller.signal })
      }
      entry.push(new Uint8Array(0), true)
    }
    zip.end()
  })().catch((err: Error) => out.destroy(err))
  return { stream: out, name }
}
