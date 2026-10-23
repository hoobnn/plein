import { Readable } from 'node:stream'
import { renameSync } from 'node:fs'
import { addResults, connect, createElement, deleteElements } from '@plein/doc'
import { arrangeSequence, sequenceNode, sequenceSpec } from '@plein/nodes'
import type { CompositionSourceRef, ComposeSpec } from '@plein/plugin-sdk'
import { API, SequenceExportRequest } from '@plein/protocol'
import { MOCK_WEBM_BASE64 } from '../../../../packages/providers/src/mock/video-fixture'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, request } from '../testing'
import { sequencePackage } from './interchange'
import { hasFfmpeg } from './media'

const available = await hasFfmpeg()
async function setup() {
  const { server } = await bootServer()
  const image = strToU8(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>',
  )
  const dependency = await server.assets.ingest('local', Readable.from([image]), {
    mime: 'image/svg+xml',
    name: '角色原图.svg',
  })
  const frozen = {
    template: 'character',
    title: '角色甲',
    inputs: { image: { assetId: dependency.id } },
  }
  const sourceBytes = zipSync({
    'index.html': strToU8('<html><body>角色甲<img src="media/image.svg"></body></html>'),
    'media/image.svg': image,
  })
  const bundle = await server.assets.ingest('local', Readable.from([sourceBytes]), {
    mime: 'application/zip',
    name: 'source.zip',
  })
  const manifestBytes = strToU8(JSON.stringify(frozen))
  const manifest = await server.assets.ingest('local', Readable.from([manifestBytes]), {
    mime: 'application/json',
    name: 'manifest.json',
  })
  const clip = await server.assets.ingest(
    'local',
    Readable.from([Buffer.from(MOCK_WEBM_BASE64, 'base64')]),
    { mime: 'video/webm', name: '角色甲.webm' },
  )
  const source: CompositionSourceRef = {
    version: 1,
    bundleAssetId: bundle.id,
    manifestAssetId: manifest.id,
    dependencyAssetIds: [dependency.id],
    rendererIdentity: 'test-hyperframes',
  }
  const params = sequenceNode.params.parse({
    subtitles: false,
    aspectRatio: '16:9',
    resolution: '720p',
  })
  const arranged = arrangeSequence(params, {
    clips: [
      {
        type: 'video',
        kind: 'video',
        assetId: clip.id,
        mime: clip.mime,
        source: 'motion-node',
        compositionSource: source,
      },
    ],
  })
  const spec = sequenceSpec(
    params,
    arranged,
    { clips: [clip.duration ?? 1], dialogue: [] },
    undefined,
    'motion-export',
  )
  return { server, spec, clip, source, bundle, dependency, sourceBytes, manifestBytes }
}
async function bytesOf(stream: Readable) {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

describe.skipIf(!available)('动态合成NLE工程交付', () => {
  it('sequenceSpec与协议保留来源；真实HTTP导出同时含可读OTIO/FCPXML、媒体及原样源ZIP/manifest', async () => {
    const s = await setup()
    const parsed = SequenceExportRequest.parse({ spec: s.spec })
    expect(parsed.spec.clips[0]?.asset.compositionSource).toEqual(s.source)
    const created = await request(s.server, API.sequenceExport, {
      method: 'POST',
      body: JSON.stringify(parsed),
    })
    expect(created.status).toBe(201)
    const { url } = (await created.json()) as { url: string }
    const downloaded = await request(s.server, url)
    expect(downloaded.status).toBe(200)
    const files = unzipSync(new Uint8Array(await downloaded.arrayBuffer()))
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        'motion-export/timeline.otio',
        'motion-export/timeline.fcpxml',
        'motion-export/sources/1/source.zip',
        'motion-export/sources/1/manifest.json',
      ]),
    )
    expect(files['motion-export/sources/1/source.zip']).toEqual(s.sourceBytes)
    expect(files['motion-export/sources/1/manifest.json']).toEqual(s.manifestBytes)
    const reopenedSource = unzipSync(files['motion-export/sources/1/source.zip']!)
    expect(strFromU8(reopenedSource['index.html']!)).toContain('角色甲')
    expect(reopenedSource['media/image.svg']).toBeDefined()
    const media = Object.entries(files).filter(([path]) => path.startsWith('motion-export/media/'))
    expect(media).toHaveLength(1)
    expect(media[0]![1]).toEqual(await s.server.assets.readOriginal('local', s.clip.id))
    expect(decodeURI(strFromU8(files['motion-export/timeline.fcpxml']!))).toContain(
      media[0]![0].replace('motion-export/', ''),
    )
    expect(JSON.parse(strFromU8(files['motion-export/timeline.otio']!))).toBeTruthy()
  })

  it('普通视频副本在原motion删除后仍通过服务端输入收集与NLE归档保留来源', async () => {
    const s = await setup()
    const { doc } = await createCanvas(s.server)
    const original = addNode(doc, 'plein/motion')
    addResults(doc, original, [
      {
        id: 'motion-result',
        runId: 'motion-run',
        port: 'video',
        at: Date.now(),
        value: { type: 'video', assetId: s.clip.id, compositionSource: s.source },
      },
    ])
    const copy = createElement(doc, {
      kind: 'video',
      assetId: s.clip.id,
      params: { compositionSource: s.source },
      x: 300,
      y: 0,
      w: 320,
      h: 180,
    })
    deleteElements(doc, [original])
    const sequence = addNode(doc, 'plein/sequence', { params: { subtitles: false } })
    connect(doc, [copy, 'video'], [sequence, 'clips'])
    const prepared = await s.server.runs.inspect(
      doc,
      doc.get(sequence)!,
      'local',
      new AbortController().signal,
    )
    expect(prepared.inputs.clips?.[0]).toMatchObject({ compositionSource: s.source })
    const params = sequenceNode.params.parse(doc.get(sequence)?.params)
    const spec = sequenceSpec(
      params,
      arrangeSequence(params, prepared.inputs),
      { clips: [s.clip.duration ?? 1], dialogue: [] },
      undefined,
      'copy-source',
    )
    const archive = await sequencePackage(s.server.assets, 'local', spec)
    const files = unzipSync(await bytesOf(archive.stream))
    expect(files['copy-source/sources/1/source.zip']).toEqual(s.sourceBytes)
    expect(files['copy-source/sources/1/manifest.json']).toEqual(s.manifestBytes)
    doc.destroy()
  })

  it('同一合成重复用于多个镜头只附一份源，但每个镜头仍留在时间线', async () => {
    const s = await setup()
    const spec: ComposeSpec = { ...s.spec, clips: [...s.spec.clips, ...s.spec.clips] }
    const archive = await sequencePackage(s.server.assets, 'local', spec)
    const files = unzipSync(await bytesOf(archive.stream))
    expect(Object.keys(files).filter((path) => path.endsWith('/source.zip'))).toHaveLength(1)
    const timeline = JSON.parse(strFromU8(files['motion-export/timeline.otio']!))
    expect(timeline.tracks.children[0].children).toHaveLength(2)
  })

  it('源属于其他owner时在发下载链接之前拒绝，不能把共享磁盘上的文件打入包', async () => {
    const s = await setup()
    const foreign = await s.server.assets.ingest('other', Readable.from(['foreign-only-source']), {
      mime: 'application/zip',
      name: 'secret.zip',
    })
    s.spec.clips[0]!.asset.compositionSource = { ...s.source, bundleAssetId: foreign.id }
    const created = await request(s.server, API.sequenceExport, {
      method: 'POST',
      body: JSON.stringify({ spec: s.spec }),
    })
    expect(created.status).toBe(404)
    expect(await created.text()).not.toContain('secret.zip')
    await expect(sequencePackage(s.server.assets, 'local', s.spec)).rejects.toThrow('源工程')
  })

  it.each(['bundleAssetId', 'manifestAssetId', 'dependencyAssetIds'] as const)(
    '已声明来源%s的原件缺失时拒绝生成可交付工程',
    async (field) => {
      const s = await setup()
      const id = field === 'dependencyAssetIds' ? s.source.dependencyAssetIds[0]! : s.source[field]
      const path = s.server.assets.originalPath(id)
      renameSync(path, `${path}.missing`)
      await expect(sequencePackage(s.server.assets, 'local', s.spec)).rejects.toThrow()
    },
  )
})
