import {
  adoptResult,
  createDoc,
  createElement,
  currentResult,
  deleteElements,
  setParam,
} from '@plein/doc'
import { defaultStageScene, STAGE_TYPE, stageSnapshotsOf } from '@plein/nodes'
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
