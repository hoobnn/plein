import {
  adoptResult,
  createDoc,
  createElement,
  currentResult,
  deleteElements,
  setParam,
} from '@plein/doc'
import { defaultStageScene, MAX_STAGE_SNAPSHOTS, STAGE_TYPE, stageSnapshotsOf } from '@plein/nodes'
import * as Y from 'yjs'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { api } from '../../api/client'
import { saveSnapshot } from './snapshot'

vi.mock('../../api/client', () => ({ api: { upload: vi.fn() } }))
afterEach(() => vi.resetAllMocks())

function setup() {
  const doc = createDoc()
  const scene = defaultStageScene()
  const id = createElement(doc, {
    kind: 'node',
    nodeType: STAGE_TYPE,
    x: 0,
    y: 0,
    w: 480,
    h: 270,
    params: { scene },
    results: [
      {
        id: 'original',
        port: 'image',
        value: { type: 'image', assetId: 'original', mime: 'image/png' },
        runId: 'r1',
        at: 1,
      },
      {
        id: 'choice',
        port: 'image',
        value: { type: 'image', assetId: 'choice', mime: 'image/png' },
        runId: 'r2',
        at: 2,
      },
    ],
    adopted: 'original',
  })
  let resolve!: (asset: Awaited<ReturnType<typeof api.upload>>) => void
  vi.mocked(api.upload).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const finish = () => resolve({ id: 'uploaded' } as Awaited<ReturnType<typeof api.upload>>)
  doc.undo.clear()
  return { doc, id, scene, finish }
}

describe('3D 截图保存', () => {
  it.each(['编码', '上传'] as const)(
    '%s期间同 ID 节点被替换，旧截图不能写入新节点',
    async (phase) => {
      const { doc, id, scene, finish } = setup()
      const element = doc.mutable(id)!
      const replace = () => {
        doc.ydoc.transact(() => doc.elementMaps.set(id, element.clone()), doc.origin)
        doc.flush()
      }
      if (phase === '编码') replace()
      const run = saveSnapshot(doc, id, scene, new Blob(), { resultId: 'original', element })
      if (phase === '上传') replace()
      const before = doc.get(id)
      if (phase === '上传') finish()
      await expect(run).rejects.toThrow('节点已被替换')
      expect(doc.get(id)).toEqual(before)
      expect(api.upload).toHaveBeenCalledTimes(phase === '编码' ? 0 : 1)
      doc.destroy()
    },
  )

  it('编码期间关闭画布，拒绝上传到已经销毁的文档', async () => {
    const { doc, id, scene } = setup()
    doc.destroy()
    doc.ydoc.destroy()
    await expect(saveSnapshot(doc, id, scene, new Blob())).rejects.toThrow('画布已经关闭')
    expect(api.upload).not.toHaveBeenCalled()
  })

  it('上传期间关闭画布，迟到结果不再写入已断开的文档', async () => {
    const { doc, id, scene, finish } = setup()
    const run = saveSnapshot(doc, id, scene, new Blob())
    const before = Y.encodeStateAsUpdate(doc.ydoc)
    doc.destroy()
    doc.ydoc.destroy()
    finish()
    await expect(run).rejects.toThrow('画布已经关闭')
    expect(Y.encodeStateAsUpdate(doc.ydoc)).toEqual(before)
  })

  it('候选达到上限时保留已采用截图的来源，来源列表与保留结果一致且可重新打开', async () => {
    const { doc, id, scene } = setup()
    vi.mocked(api.upload).mockResolvedValue({ id: 'uploaded' } as Awaited<
      ReturnType<typeof api.upload>
    >)
    const original = { ...scene, aspect: '9:16' as const }
    const adopted = await saveSnapshot(doc, id, original, new Blob())
    for (let rev = 1; rev <= MAX_STAGE_SNAPSHOTS; rev++) {
      await saveSnapshot(doc, id, { ...scene, rev }, new Blob(), { resultId: 'older-baseline' })
    }
    const results = doc.get(id)!.results!
    const snapshots = stageSnapshotsOf(doc.get(id)?.params)
    expect(results).toHaveLength(MAX_STAGE_SNAPSHOTS)
    expect(snapshots).toHaveLength(MAX_STAGE_SNAPSHOTS)
    expect(currentResult(doc.get(id)!)?.id).toBe(adopted.resultId)
    expect(snapshots.find((s) => s.resultId === adopted.resultId)?.scene).toEqual(original)
    expect(snapshots.map((s) => s.resultId).sort()).toEqual(results.map((r) => r.id).sort())
    const raw = new Y.Doc()
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(doc.ydoc))
    const reopened = createDoc(raw)
    expect(stageSnapshotsOf(reopened.get(id)?.params)).toEqual(snapshots)
    expect(currentResult(reopened.get(id)!)?.id).toBe(adopted.resultId)
    reopened.destroy()
    doc.destroy()
  })

  it('上传期间手动采用其他画面，迟到截图仅保存为候选，不能改变画幅或当前画面', async () => {
    const { doc, id, scene, finish } = setup()
    const run = saveSnapshot(doc, id, { ...scene, aspect: '9:16' }, new Blob())
    adoptResult(doc, id, 'choice')
    finish()
    const shot = await run
    expect(currentResult(doc.get(id)!)?.id).toBe('choice')
    expect(doc.get(id)).toMatchObject({ w: 480, h: 270 })
    expect(doc.get(id)?.results).toHaveLength(3)
    expect(stageSnapshotsOf(doc.get(id)?.params)[0]?.resultId).toBe(shot.resultId)
    doc.destroy()
  })

  it.each(['删除', '只读'] as const)('上传期间%s，拒绝保存且不产生部分记录', async (kind) => {
    const { doc, id, scene, finish } = setup()
    const run = saveSnapshot(doc, id, scene, new Blob())
    if (kind === '删除') deleteElements(doc, [id])
    else doc.readOnly = true
    const before = [...doc.elements()]
    finish()
    await expect(run).rejects.toThrow()
    expect([...doc.elements()]).toEqual(before)
    doc.destroy()
  })

  it('正常截图采用结果、记录原场景和画幅，系统保存不混入场景撤销', async () => {
    const { doc, id, scene, finish } = setup()
    const captured = { ...scene, aspect: '9:16' as const }
    const run = saveSnapshot(doc, id, captured, new Blob())
    setParam(doc, id, 'scene', { ...scene, rev: scene.rev + 1 })
    finish()
    const shot = await run
    expect(currentResult(doc.get(id)!)?.id).toBe(shot.resultId)
    expect(doc.get(id)!.w / doc.get(id)!.h).toBeCloseTo(9 / 16, 2)
    expect(stageSnapshotsOf(doc.get(id)?.params)[0]?.scene).toEqual(captured)
    doc.undo.undo()
    expect(doc.get(id)?.params?.scene).toEqual(scene)
    expect(currentResult(doc.get(id)!)?.id).toBe(shot.resultId)
    doc.destroy()
  })
})
