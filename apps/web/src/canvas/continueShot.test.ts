import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, connect, createDoc, createElement } from '@plein/doc'
import { describe, expect, it } from 'vite-plus/test'
import { nearestAspect } from '@plein/nodes'
import { continueParams, continuesFromOf, continueStale } from './continueShot'
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
