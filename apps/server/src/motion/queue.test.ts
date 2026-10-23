import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi, beforeEach } from 'vite-plus/test'
import { adoptResult, connect, currentResult, setParam } from '@plein/doc'
import { MotionParams } from '@plein/nodes'
import { MOCK_WEBM_BASE64 } from '../../../../packages/providers/src/mock/video-fixture'
import { bootServer, createCanvas, addNode, until, tempDir, request } from '../testing'
import { renderMotion } from './render'

vi.mock('./render', async (original) => ({
  ...(await original<typeof import('./render')>()),
  renderMotion: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(renderMotion)
    .mockReset()
    .mockImplementation(async (params, inputs, dir) => {
      const outputPath = join(dir, 'output.mp4')
      await writeFile(outputPath, Buffer.from(MOCK_WEBM_BASE64, 'base64'))
      return {
        outputPath,
        sourceZip: new Uint8Array([80, 75, 3, 4]),
        identity: 'test-renderer',
        warnings: [],
        manifest: {
          schema: 'plein.motion-source.v1',
          templateVersion: 1,
          engine: { name: 'hyperframes', version: '0.8.186', fps: 30 },
          params,
          inputs: {},
          dependencyAssetIds: Object.values(inputs).map((input) => input.assetId),
          dimensions: { width: 1280, height: 720 },
          durationFrames: 30,
          renderIdentity: 'test-renderer',
          files: [],
          runtime: { encoder: 'test', ffmpegVersion: 'test', ffprobeVersion: 'test' },
        },
      }
    })
})

/** 冻结记录里的原输入；产出证据会随运行追加，不属于原输入。 */
const frozenInput = (value: string | null) => {
  const record = JSON.parse(value ?? '{}') as {
    params?: unknown
    inputs?: unknown
    inputHash?: unknown
  }
  return { params: record.params, inputs: record.inputs, inputHash: record.inputHash }
}

describe('动态合成任务与候选', () => {
  it('真实队列落地保留冻结来源，首次与再次渲染均等待明确采用', async () => {
    const { server } = await bootServer()
    const { id: canvasId, doc } = await createCanvas(server)
    const nodeId = addNode(doc, 'plein/motion', {
      params: MotionParams.parse({ title: '原版', duration: 1 }),
    })
    const first = server.runs.start(canvasId, nodeId, 'local')
    expect(await server.runs.wait(first)).toBe('succeeded')
    const original = doc.get(nodeId)!.results![0]!
    expect(currentResult(doc.get(nodeId)!)).toBeUndefined()
    expect(original.value).toMatchObject({
      type: 'video',
      compositionSource: { version: 1, rendererIdentity: 'test-renderer' },
    })
    if (!('assetId' in original.value)) throw new Error('missing video')
    const source = original.value.compositionSource!
    const manifest = JSON.parse(
      new TextDecoder().decode(await server.assets.readOriginal('local', source.manifestAssetId)),
    )
    expect(manifest.params.title).toBe('原版')
    expect(server.assets.get('local', source.bundleAssetId)).not.toBeNull()
    adoptResult(doc, nodeId, original.id)
    setParam(doc, nodeId, 'title', '新版')
    expect(await server.runs.wait(server.runs.start(canvasId, nodeId, 'local'))).toBe('succeeded')
    expect(doc.get(nodeId)!.results).toHaveLength(2)
    expect(currentResult(doc.get(nodeId)!)?.id).toBe(original.id)
    expect(manifest.params.title).toBe('原版')
    const second = doc.get(nodeId)!.results!.find((result) => result.id !== original.id)!
    const calls = vi.mocked(renderMotion).mock.calls.length
    const review = server.runs.runImpact(canvasId, 'local', { nodes: [nodeId], force: false })
    await until(() => server.runs.store.group(review.groupId)?.status === 'done', 10_000)
    expect(server.runs.store.batchItem(review.groupId, nodeId)).toMatchObject({
      outcome: 'review',
      result_id: second.id,
    })
    expect(vi.mocked(renderMotion).mock.calls).toHaveLength(calls)
    expect(currentResult(doc.get(nodeId)!)?.id).toBe(original.id)
    adoptResult(doc, nodeId, second.id)
    const adopted = server.runs.runImpact(canvasId, 'local', { nodes: [nodeId], force: false })
    await until(() => server.runs.store.group(adopted.groupId)?.status === 'done', 10_000)
    expect(server.runs.store.batchItem(adopted.groupId, nodeId)).toMatchObject({
      outcome: 'cached',
      result_id: second.id,
    })
    expect(vi.mocked(renderMotion).mock.calls).toHaveLength(calls)
    const sources = await request(server, `/api/motion/asset/${original.value.assetId}/sources`)
    expect(sources.status).toBe(200)
    const choices = (await sources.json()) as { sources: { title: string }[] }
    expect(choices.sources.map((source) => source.title).sort()).toEqual(['原版', '新版'])
  })

  it('运行快照和renderer身份参与缓存，后台渲染不写回后来的编辑', async () => {
    const { server } = await bootServer()
    const { id: canvasId, doc } = await createCanvas(server)
    const nodeId = addNode(doc, 'plein/motion', {
      params: MotionParams.parse({ duration: 1, title: '冻结值' }),
    })
    const fingerprint = vi
      .spyOn(server.plugins, 'compositionRendererIdentity')
      .mockReturnValue('build-a')
    const before = await server.runs.preview(canvasId, nodeId, 'local')
    fingerprint.mockReturnValue('build-b')
    const after = await server.runs.preview(canvasId, nodeId, 'local')
    expect(after.inputHash).not.toBe(before.inputHash)
    const implementation = vi.mocked(renderMotion).getMockImplementation()!
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(renderMotion).mockImplementation(async (...args) => {
      await waiting
      return implementation(...args)
    })
    const runId = server.runs.start(canvasId, nodeId, 'local')
    await vi.waitFor(() => expect(renderMotion).toHaveBeenCalled())
    setParam(doc, nodeId, 'title', '后来编辑')
    release()
    expect(await server.runs.wait(runId)).toBe('succeeded')
    expect(doc.get(nodeId)?.params?.title).toBe('后来编辑')
    expect(currentResult(doc.get(nodeId)!)).toBeUndefined()
  })
  it('新包装尚未采用时run_flow阻断下游，不会静默拿旧包装导出', async () => {
    const { server } = await bootServer()
    const { id: canvasId, doc } = await createCanvas(server)
    const motion = addNode(doc, 'plein/motion', {
      params: MotionParams.parse({ title: '旧包装', duration: 1 }),
    })
    expect(await server.runs.wait(server.runs.start(canvasId, motion, 'local'))).toBe('succeeded')
    const old = doc.get(motion)!.results![0]!
    adoptResult(doc, motion, old.id)
    const sequence = addNode(doc, 'plein/sequence', { params: { subtitles: false } })
    connect(doc, [motion, 'video'], [sequence, 'clips'])
    setParam(doc, motion, 'title', '新包装')
    const { groupId } = server.runs.runFlow(canvasId, sequence, 'local', {
      scope: 'upstream',
      force: false,
    })
    await until(() => server.runs.store.group(groupId)?.status === 'done', 10_000)
    expect(server.runs.store.batchItem(groupId, motion)).toMatchObject({ outcome: 'review' })
    expect(server.runs.store.batchItem(groupId, sequence)).toMatchObject({ outcome: 'skipped' })
    expect(doc.get(sequence)?.run).toBeUndefined()
    expect(currentResult(doc.get(motion)!)?.id).toBe(old.id)
    expect(JSON.parse(server.runs.store.group(groupId)!.summary!)).toMatchObject({
      review: 1,
      failed: 0,
      skipped: 1,
    })
  })

  it('服务重启保留同一run冻结的原输入，不因本地任务没有Provider calls而重读新参数', async () => {
    const dataDir = tempDir('plein-motion-restart-')
    const first = await bootServer({ dataDir })
    const { id: canvasId, doc } = await createCanvas(first.server)
    const nodeId = addNode(doc, 'plein/motion', {
      params: MotionParams.parse({ title: '冻结原版', duration: 1 }),
    })
    const implementation = vi.mocked(renderMotion).getMockImplementation()!
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    vi.mocked(renderMotion).mockImplementationOnce(async (...args) => {
      started()
      await new Promise<void>((_resolve, reject) =>
        args[3].signal!.addEventListener(
          'abort',
          () => reject(new DOMException('stopped', 'AbortError')),
          { once: true },
        ),
      )
      return implementation(...args)
    })
    const runId = first.server.runs.start(canvasId, nodeId, 'local')
    await entered
    setParam(doc, nodeId, 'title', '之后改成新版')
    const frozenBefore = first.server.runs.store.get(runId)!.frozen
    const finishing = first.server.runs.wait(runId)
    await first.close()
    await finishing
    const second = await bootServer({ dataDir })
    expect(await second.server.runs.wait(runId)).toBe('succeeded')
    expect(vi.mocked(renderMotion).mock.calls.at(-1)![0].title).toBe('冻结原版')
    expect(frozenInput(second.server.runs.store.get(runId)!.frozen)).toEqual(
      frozenInput(frozenBefore),
    )
    const current = second.server.rooms.withDoc(canvasId, (d) => d.get(nodeId)!)
    expect(current.params?.title).toBe('之后改成新版')
    expect(currentResult(current)).toBeUndefined()
  })
})
