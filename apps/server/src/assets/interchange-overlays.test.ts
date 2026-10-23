import { execFileSync } from 'node:child_process'
import { createReadStream, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { ComposeSpec, CompositionSourceRef } from '@plein/plugin-sdk'
import { API, SequenceExportRequest } from '@plein/protocol'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vite-plus/test'
import { bootServer, request, tempDir } from '../testing'
import { sequencePackage } from './interchange'
import { ffmpegBin, hasFfmpeg } from './media'

const available = await hasFfmpeg()
async function fixture() {
  const { server } = await bootServer()
  const dir = tempDir()
  async function video(name: string, color: string, owner = 'local') {
    const file = join(dir, name)
    execFileSync(ffmpegBin(), [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=64x64:r=30:d=4`,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=4',
      '-c:v',
      'mpeg4',
      '-c:a',
      'aac',
      '-shortest',
      file,
    ])
    return server.assets.ingest(owner, createReadStream(file), { mime: 'video/mp4', name })
  }
  const [background, overlay] = await Promise.all([
    video('background.mp4', 'blue'),
    video('overlay.mp4', 'red'),
  ])
  const file = (owner: string, body: string | Uint8Array, mime = 'application/octet-stream') =>
    server.assets.ingest(owner, Readable.from([body]), { mime, name: 'source' })
  const [bundle, manifest, dependency] = await Promise.all([
    file('local', zipSync({ 'index.html': strToU8('<html>overlay</html>') }), 'application/zip'),
    file(
      'local',
      JSON.stringify({ title: 'overlay', params: { title: 'overlay' } }),
      'application/json',
    ),
    file('local', 'overlay-dependency'),
  ])
  const source: CompositionSourceRef = {
    version: 1,
    bundleAssetId: bundle.id,
    manifestAssetId: manifest.id,
    dependencyAssetIds: [dependency.id],
    rendererIdentity: 'overlay/test',
  }
  const spec: ComposeSpec = {
    name: 'overlay-export',
    width: 1280,
    height: 720,
    fps: 30,
    clips: [{ asset: { assetId: background.id, kind: 'video' }, in: 0, out: 4, volume: 0.3 }],
    audio: [],
    overlays: [
      {
        id: 'overlay-1',
        asset: { assetId: overlay.id, kind: 'video', compositionSource: source },
        start: 1,
        duration: 2,
        in: 0.5,
        speed: 1.5,
        x: 0.2,
        y: 0.3,
        width: 0.5,
        height: 0.4,
        opacity: 0.6,
      },
    ],
    subtitles: {
      cues: [
        {
          id: 'cue-1',
          source: 'background-node',
          origin: 'manual',
          start: 0.2,
          end: 2,
          text: '手工对齐的动画字幕',
        },
      ],
      style: 'bold',
      render: 'animated',
      animation: 'pop',
    },
  }
  const exportSpec = async (value: ComposeSpec = spec) => {
    const created = await request(server, API.sequenceExport, {
      method: 'POST',
      body: JSON.stringify({ spec: value }),
    })
    expect(created.status).toBe(201)
    return request(server, ((await created.json()) as { url: string }).url)
  }
  return { server, background, overlay, source, spec, file, exportSpec }
}

describe.skipIf(!available)('叠加与动画字幕 NLE 交付边界', () => {
  it('协议保留叠加和 cue 来源，拒绝非有限时间或非法归一化 geometry', async () => {
    const f = await fixture()
    expect(SequenceExportRequest.parse({ spec: f.spec }).spec).toMatchObject(f.spec)
    for (const patch of [{ width: 0 }, { opacity: 2 }, { start: Infinity }, { speed: 0.1 }])
      expect(
        SequenceExportRequest.safeParse({
          spec: { ...f.spec, overlays: [{ ...f.spec.overlays![0], ...patch }] },
        }).success,
      ).toBe(false)
  })

  it('真实媒体包保留独立轨、真实 duration、背景原声和原样来源；动画字幕附离线源 ZIP 及准确 provenance', async () => {
    const f = await fixture()
    // 元数据不能替代真实素材时长；导出仍按 ffprobe 的真实窗口进行校验和声明。
    f.server.db.$client.prepare('UPDATE assets SET duration=99 WHERE id=?').run(f.overlay.id)
    const response = await f.exportSpec()
    expect(response.status).toBe(200)
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
    const otio = JSON.parse(strFromU8(files['overlay-export/timeline.otio']!))
    const tracks = otio.tracks.children
    expect(tracks.map((track: { kind: string }) => track.kind)).toEqual(['Video', 'Video', 'Audio'])
    expect(tracks[2].children[0].metadata.plein.volume).toBe(0.3)
    expect(tracks[2].children[0].media_references.DEFAULT_MEDIA.target_url).toContain('background')
    const layer = tracks[1].children[1]
    expect(layer.media_references.DEFAULT_MEDIA.available_range.duration.value).toBeCloseTo(120, 0)
    expect(layer.metadata.plein.overlay).toMatchObject({
      id: 'overlay-1',
      in: 0.5,
      speed: 1.5,
      opacity: 0.6,
    })
    const xml = strFromU8(files['overlay-export/timeline.fcpxml']!)
    expect(xml).toContain('srcEnable="video"')
    expect(xml).toContain('amount="-10.5dB"')
    expect(Object.keys(files).filter((path) => path.includes('/media/'))).toHaveLength(2)
    expect(files['overlay-export/sources/1/source.zip']).toBeDefined()
    expect(files['overlay-export/sources/1/manifest.json']).toBeDefined()
    expect(strFromU8(files['overlay-export/subtitles.srt']!)).toContain(
      '00:00:00,200 --> 00:00:02,000',
    )
    expect(JSON.parse(strFromU8(files['overlay-export/caption-cues.json']!)).cues[0]).toEqual(
      f.spec.subtitles!.cues[0],
    )
    const captionFiles = unzipSync(files['overlay-export/sources/captions/source.zip']!)
    const captionManifest = JSON.parse(strFromU8(captionFiles['manifest.json']!))
    expect(captionManifest.schema).toBe('plein.caption-source.v1')
    expect(captionManifest.params.cues).toEqual(f.spec.subtitles!.cues)
    expect(captionManifest.params.animation).toBe('pop')
    expect(strFromU8(captionFiles['index.html']!)).toContain('gsap.timeline({paused:true})')
    expect(Object.keys(captionFiles)).toContain('fonts/noto-sans-sc.css')
    const readme = strFromU8(files['overlay-export/README.txt']!)
    expect(readme).toContain('OTIO 保留叠加起点')
    expect(readme).toContain('导入软件不一定应用')
    expect(readme).toContain('自带声音不加入混音')
  })

  it('render none 仍导出 SRT 和 cue 身份，但不制造动画源 ZIP', async () => {
    const f = await fixture()
    const response = await f.exportSpec({
      ...f.spec,
      subtitles: { ...f.spec.subtitles!, render: 'none' },
    })
    expect(response.status).toBe(200)
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
    expect(files['overlay-export/subtitles.srt']).toBeDefined()
    expect(files['overlay-export/caption-cues.json']).toBeDefined()
    expect(files['overlay-export/sources/captions/source.zip']).toBeUndefined()
  })

  it('overlay 素材和声明的源资产全部按 owner 检查，不能获得下载令牌', async () => {
    const f = await fixture()
    const foreign = await f.file('other-owner', 'foreign-source')
    for (const asset of [
      { ...f.spec.overlays![0]!.asset, assetId: foreign.id },
      {
        ...f.spec.overlays![0]!.asset,
        compositionSource: { ...f.source, dependencyAssetIds: [foreign.id] },
      },
    ]) {
      const response = await request(f.server, API.sequenceExport, {
        method: 'POST',
        body: JSON.stringify({
          spec: { ...f.spec, overlays: [{ ...f.spec.overlays![0], asset }] },
        }),
      })
      expect(response.status).toBe(404)
      expect(await response.text()).not.toContain(foreign.id)
    }
  })

  it.each(['overlay', 'dependency'] as const)(
    'owned %s 原件缺失或损坏时下载硬失败',
    async (kind) => {
      const f = await fixture()
      if (kind === 'overlay')
        writeFileSync(f.server.assets.originalPath(f.overlay.id), 'corrupt video')
      else {
        const path = f.server.assets.originalPath(f.source.dependencyAssetIds[0]!)
        renameSync(path, `${path}.missing`)
      }
      expect((await f.exportSpec()).status).toBe(404)
    },
  )

  it('同 bundle 的第二处源声明也校验全部依赖，不能由打包去重绕过', async () => {
    const f = await fixture()
    const missing = 'd'.repeat(64)
    const secondManifest = await f.file(
      'local',
      JSON.stringify({ params: { title: 'second' } }),
      'application/json',
    )
    const spec: ComposeSpec = {
      ...f.spec,
      overlays: [
        f.spec.overlays![0]!,
        {
          ...f.spec.overlays![0]!,
          id: 'second',
          asset: {
            ...f.spec.overlays![0]!.asset,
            compositionSource: {
              ...f.source,
              manifestAssetId: secondManifest.id,
              dependencyAssetIds: [missing],
            },
          },
        },
      ],
    }
    await expect(sequencePackage(f.server.assets, 'local', spec)).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('overlay trim/speed 窗口必须由真实时长覆盖，数据库 duration 不能掩盖不足', async () => {
    const f = await fixture()
    f.server.db.$client.prepare('UPDATE assets SET duration=99 WHERE id=?').run(f.overlay.id)
    const response = await f.exportSpec({
      ...f.spec,
      overlays: [{ ...f.spec.overlays![0]!, in: 3, speed: 2 }],
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      error: 'invalid',
      message: expect.stringContaining('源素材不足'),
    })
  })
})
