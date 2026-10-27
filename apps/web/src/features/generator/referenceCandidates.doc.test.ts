import type { Engine } from '@plein/canvas-core'
import { connect, createElement, inputEdges, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { filterReferenceCandidates, referenceCandidates } from './referenceCandidates'

const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))

/** 目标节点：一个图片口（可多接）与一个视频口（单接） */
function setup() {
  const doc = openDoc()
  docs.push(doc)
  const target = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/video',
    name: '目标',
    x: 0,
    y: 0,
    w: 200,
    h: 100,
    ports: {
      inputs: [
        { id: 'images', label: '图片', type: 'image', multiple: true },
        { id: 'videos', label: '视频', type: 'video' },
      ],
      outputs: [],
    },
  })
  // 两个可接的来源：图片与视频
  const image = createElement(doc, {
    kind: 'image',
    name: '画布中的人物图',
    assetId: 'a1',
    x: 0,
    y: 200,
    w: 100,
    h: 100,
  })
  const video = createElement(doc, {
    kind: 'video',
    name: '接入素材的视频',
    assetId: 'v1',
    x: 200,
    y: 200,
    w: 100,
    h: 100,
  })
  const engine = { doc } as unknown as Engine
  return { doc, engine, target, image, video }
}

const media = [
  { id: 'images', type: 'image', label: '图片', multiple: true },
  { id: 'videos', type: 'video', label: '视频' },
]

describe('画布参考候选', () => {
  it('列出别处能接进本节点媒体口的输出，排除本节点自己', () => {
    const { engine, target } = setup()
    const candidates = referenceCandidates(engine, { id: target }, media)
    const refs = candidates.map((c) => `${c.sourceName}/${c.outputId}→${c.portId}`)
    expect(refs).toContain('画布中的人物图/image→images')
    expect(refs).toContain('接入素材的视频/video→videos')
    // 类型不匹配的输出不进对应端口
    expect(refs).not.toContain('画布中的人物图/image→videos')
    // 本节点自己不出现在候选里
    expect(candidates.some((c) => c.sourceId === target)).toBe(false)
    expect(candidates.some((c) => c.sourceName === '画布中的人物图')).toBe(true)
  })

  it('同一个输出已经接过一次就不再重复出现', () => {
    const { doc, engine, target, image } = setup()
    connect(doc, [image, 'image'], [target, 'images'])
    const candidates = referenceCandidates(engine, { id: target }, media)
    expect(candidates.some((c) => c.sourceId === image && c.outputId === 'image')).toBe(false)
  })

  it('单入口的端口被占满后不再作为候选', () => {
    const { doc, engine, target, video } = setup()
    // 先用另一个视频占满单入口
    const other = createElement(doc, {
      kind: 'video',
      name: '另一个视频',
      assetId: 'v2',
      x: 400,
      y: 200,
      w: 100,
      h: 100,
    })
    connect(doc, [other, 'video'], [target, 'videos'])
    const candidates = referenceCandidates(engine, { id: target }, media)
    expect(candidates.some((c) => c.portId === 'videos')).toBe(false)
    // 多入口的图片口仍然可用
    expect(candidates.some((c) => c.portId === 'images')).toBe(true)
    expect(video).toBeTruthy()
  })

  it('多入口的端口占了一个也不影响继续接', () => {
    const { doc, engine, target, image } = setup()
    // 再放一张图：多入口的口可以接多张
    const other = createElement(doc, {
      kind: 'image',
      name: '另一张图',
      assetId: 'a2',
      x: 300,
      y: 200,
      w: 100,
      h: 100,
    })
    connect(doc, [image, 'image'], [target, 'images'])
    const candidates = referenceCandidates(engine, { id: target }, media)
    // 已接的那张不再重复出现，另一张仍可接
    expect(candidates.some((c) => c.sourceName === '画布中的人物图')).toBe(false)
    expect(candidates.some((c) => c.sourceName === '另一张图')).toBe(true)
    expect(inputEdges(doc, target, 'images')).toHaveLength(1)
    expect(other).toBeTruthy()
  })

  it('接入后撤销会移除连线，候选重新出现', () => {
    const { doc, engine, target, image } = setup()
    const candidates = referenceCandidates(engine, { id: target }, media)
    expect(candidates.some((c) => c.sourceName === '画布中的人物图')).toBe(true)
    doc.undo.stopCapturing()
    connect(doc, [image, 'image'], [target, 'images'])
    doc.flush()
    expect(inputEdges(doc, target, 'images')).toHaveLength(1)
    // 撤销
    doc.undo.undo()
    doc.flush()
    expect(inputEdges(doc, target, 'images')).toHaveLength(0)
    expect(
      referenceCandidates(engine, { id: target }, media).some(
        (c) => c.sourceName === '画布中的人物图',
      ),
    ).toBe(true)
  })

  it('候选按名字与端口标签搜索', () => {
    const { engine, target } = setup()
    const candidates = referenceCandidates(engine, { id: target }, media)
    expect(filterReferenceCandidates(candidates, '人物图')).toHaveLength(1)
    expect(filterReferenceCandidates(candidates, '人物图')[0]!.sourceName).toBe('画布中的人物图')
    expect(filterReferenceCandidates(candidates, '视频')).toHaveLength(1)
    expect(filterReferenceCandidates(candidates, '不存在')).toHaveLength(0)
    expect(filterReferenceCandidates(candidates, '')).toHaveLength(candidates.length)
  })
})
