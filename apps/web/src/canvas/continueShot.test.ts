import type { Engine } from '@plein/canvas-core'
import {
  type CanvasElement,
  connect,
  createDoc,
  createElement,
  removeEdges,
  setParam,
  updateElement,
} from '@plein/doc'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { api } from '../api/client'
import { nearestAspect } from '@plein/nodes'
import {
  continueParams,
  continueShot,
  continuesFromOf,
  continueStale,
  refreshContinue,
} from './continueShot'
import type { NodeInfo } from './nodes'

const ASPECTS = ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']

const video = {
  type: 'plein/video',
  version: 2,
  title: '生成视频',
  capability: 'video.generate',
  executable: true,
  defaults: { mode: 'text', prompt: '', duration: 5, aspectRatio: '16:9', continuesFrom: null },
  paramsSchema: {
    properties: {
      model: { type: 'string', widget: 'model' },
      mode: { type: 'string', widget: 'videoMode' },
      prompt: { type: 'string', widget: 'textarea' },
      duration: { type: 'integer' },
      aspectRatio: { type: 'string', enum: ASPECTS },
      continuesFrom: { widget: 'hidden' },
    },
  },
  inputs: [
    { id: 'prompt', label: '提示词', type: 'text', multiple: true },
    { id: 'images', label: '图片', type: 'image', multiple: true },
  ],
  outputs: [
    { id: 'video', label: '视频', type: 'video' },
    { id: 'lastFrame', label: '尾帧', type: 'image' },
  ],
} as unknown as NodeInfo

const el = (over: Partial<CanvasElement>) =>
  ({ id: 'v', kind: 'video', x: 0, y: 0, w: 480, h: 270, ...over }) as CanvasElement

describe('取帧续镜', () => {
  it('画幅取最接近画面的那个，不选「智能」', () => {
    expect(nearestAspect(ASPECTS, 1920, 1080)).toBe('16:9')
    expect(nearestAspect(ASPECTS, 720, 1280)).toBe('9:16')
    expect(nearestAspect(ASPECTS, 1000, 990)).toBe('1:1')
    expect(nearestAspect(ASPECTS, undefined, 100)).toBeUndefined()
  })

  it('父镜头是同类视频节点：沿用模型、时长、画幅，提示词留空，改成图生视频', () => {
    const parent = el({
      kind: 'node',
      nodeType: 'plein/video',
      params: { model: 'ark/seedance', prompt: '她回头', duration: 8, aspectRatio: '9:16' },
    })
    const from = { elementId: 'v', assetId: 'a1', last: true, frameAssetId: 'f1' }
    const p = continueParams(video, parent, from)
    expect(p).toMatchObject({
      model: 'ark/seedance',
      duration: 8,
      aspectRatio: '9:16',
      mode: 'image',
      prompt: '',
      continuesFrom: from,
    })
  })

  it('父镜头是导入的视频：按取出的画面比例挑画幅', () => {
    const p = continueParams(
      video,
      el({}),
      { elementId: 'v', assetId: 'a1', at: 2 },
      {
        width: 1080,
        height: 1920,
      },
    )
    expect(p.aspectRatio).toBe('9:16')
    expect(p.duration).toBe(5)
  })

  it('父镜头换了视频、首帧还是旧画面时算旧；连的是尾帧输出时不算', () => {
    const doc = createDoc()
    const engine = { doc } as unknown as Engine
    const parent = createElement(doc, { kind: 'video', assetId: 'a1', x: 0, y: 0, w: 480, h: 270 })
    const frame = createElement(doc, { kind: 'image', assetId: 'f1', x: 520, y: 0, w: 480, h: 270 })
    const next = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/video',
      x: 1040,
      y: 0,
      w: 480,
      h: 270,
      ports: {
        inputs: [{ id: 'images', label: '图片', type: 'image', multiple: true }],
        outputs: [],
      },
      params: {
        continuesFrom: { elementId: parent, assetId: 'a1', last: true, frameAssetId: 'f1' },
      },
    })
    connect(doc, [frame, 'image'], [next, 'images'])
    expect(continuesFromOf(doc.get(next))?.elementId).toBe(parent)
    expect(continueStale(engine, next)).toBe(false)
    doc.ydoc.transact(() => doc.mutable(parent)!.set('assetId', 'a2'))
    expect(continueStale(engine, next)).toBe(true)
  })
})

vi.mock('../api/client', () => ({ api: { mediaDerive: vi.fn() } }))
afterEach(() => vi.resetAllMocks())

function pendingFrame() {
  let resolve!: (result: Awaited<ReturnType<typeof api.mediaDerive>>) => void
  vi.mocked(api.mediaDerive).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  return () =>
    resolve({
      assets: [{ id: 'new-frame', name: 'frame.png', width: 320, height: 180 }],
      params: { at: 4 },
    } as unknown as Awaited<ReturnType<typeof api.mediaDerive>>)
}

function continuation() {
  const doc = createDoc()
  const engine = { doc } as unknown as Engine
  const parent = createElement(doc, {
    kind: 'video',
    assetId: 'video-new',
    x: 0,
    y: 0,
    w: 480,
    h: 270,
  })
  const frame = createElement(doc, {
    kind: 'image',
    assetId: 'frame-old',
    x: 520,
    y: 0,
    w: 480,
    h: 270,
  })
  const from = { elementId: parent, assetId: 'video-old', last: true, frameAssetId: 'frame-old' }
  const next = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/video',
    x: 1040,
    y: 0,
    w: 480,
    h: 270,
    ports: {
      inputs: [{ id: 'images', label: '图片', type: 'image', multiple: true }],
      outputs: [],
    },
    params: { continuesFrom: from, prompt: '继续走' },
  })
  const edge = connect(doc, [frame, 'image'], [next, 'images'])
  doc.undo.clear()
  return { doc, engine, parent, frame, next, edge, from }
}

describe('续镜异步取帧的保存边界', () => {
  it('创建续镜时父视频改变，拒绝接出旧画面且不创建节点', async () => {
    const { doc, engine, parent } = continuation()
    const finish = pendingFrame()
    const before = [...doc.elements()].length
    const run = continueShot(engine, { nodes: [video] } as never, parent, { last: true })
    updateElement(doc, parent, { assetId: 'video-later' })
    finish()
    await expect(run).rejects.toThrow('视频已经更换')
    expect([...doc.elements()]).toHaveLength(before)
    doc.destroy()
  })

  it.each(['视频', '首帧', '连线', '来路', '删除', '只读'] as const)(
    '更新首帧期间修改%s，拒绝旧结果且不留下部分写入',
    async (kind) => {
      const { doc, engine, parent, frame, next, edge } = continuation()
      const finish = pendingFrame()
      const run = refreshContinue(engine, next)
      if (kind === '视频') updateElement(doc, parent, { assetId: 'video-later' })
      if (kind === '首帧') updateElement(doc, frame, { assetId: 'manual-frame' })
      if (kind === '连线') removeEdges(doc, [edge!.id])
      if (kind === '来路') setParam(doc, next, 'continuesFrom', null)
      if (kind === '删除') doc.elementMaps.delete(next)
      if (kind === '只读') doc.readOnly = true
      const before = [...doc.elements()]
      const undoSteps = doc.undo.undoStack.length
      finish()
      await expect(run).rejects.toThrow()
      expect([...doc.elements()]).toEqual(before)
      expect(doc.undo.undoStack).toHaveLength(undoSteps)
      doc.destroy()
    },
  )

  it('提示词和位置编辑不影响更新；首帧与来路一起保存并可以单步撤销', async () => {
    const { doc, engine, frame, next, from } = continuation()
    const finish = pendingFrame()
    const run = refreshContinue(engine, next)
    setParam(doc, next, 'prompt', '新提示词')
    updateElement(doc, frame, { x: 600 })
    finish()
    await run
    expect(doc.get(frame)).toMatchObject({ assetId: 'new-frame', x: 600 })
    expect(doc.get(next)?.params).toMatchObject({
      prompt: '新提示词',
      continuesFrom: { assetId: 'video-new', frameAssetId: 'new-frame', at: 4 },
    })
    doc.undo.undo()
    expect(doc.get(frame)).toMatchObject({ assetId: 'frame-old', x: 600 })
    expect(doc.get(next)?.params).toMatchObject({ prompt: '新提示词', continuesFrom: from })
    doc.destroy()
  })
})

describe('取帧请求取消的最终写入保护', () => {
  it.each(['create', 'refresh'] as const)('%s 即使传输迟到返回也不写入取消结果', async (kind) => {
    const { doc, engine, parent, next } = continuation()
    const finish = pendingFrame()
    const controller = new AbortController()
    const before = [...doc.elements()]
    const undo = doc.undo.undoStack.length
    const operation =
      kind === 'create'
        ? continueShot(
            engine,
            { nodes: [video] } as never,
            parent,
            { last: true },
            { signal: controller.signal },
          )
        : refreshContinue(engine, next, controller.signal)
    controller.abort()
    finish()
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
    expect([...doc.elements()]).toEqual(before)
    expect(doc.undo.undoStack).toHaveLength(undo)
    doc.destroy()
  })
})
