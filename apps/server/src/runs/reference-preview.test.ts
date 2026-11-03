import { createDoc, createElement } from '@plein/doc'
import { videoNode } from '@plein/nodes'
import type { InputRef } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { referencePreview } from './reference-preview'

const asset = (tag: string) => tag.repeat(64)

/** 一条明细：媒体类型与「没送进去」的原因由服务端算好，预览据此写文案 */
const detail = (over: Partial<InputRef> & Pick<InputRef, 'name' | 'kind'>): InputRef => ({
  elementId: over.elementId ?? over.name,
  required: false,
  available: [],
  sent: [],
  ...over,
})

const preview = (details: InputRef[], referenceMediaLimits?: { video: number; audio: number }) => {
  const doc = createDoc(undefined, { schedule: () => {} })
  const elId = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/video',
    params: { prompt: '', mode: 'reference' },
    x: 0,
    y: 0,
    w: 10,
    h: 10,
  })
  // createElement 返回的是 id，预览要的是真正的元素
  const el = doc.get(elId)!
  return referencePreview({
    doc,
    el,
    def: videoNode,
    params: { mode: 'reference' },
    inputs: {},
    details,
    referenceLimit: 9,
    referenceMediaLimits,
  })
}

describe('参考素材超限文案按媒体类型区分', () => {
  it('视频 / 音频超限说各自的媒体上限，图片仍说参考图上限', () => {
    const r = preview(
      [
        detail({
          name: '预告片',
          kind: 'prop',
          media: 'video',
          available: [asset('a')],
          reason: 'over_limit',
        }),
        detail({
          name: '配乐',
          kind: 'prop',
          media: 'audio',
          available: [asset('b')],
          reason: 'over_limit',
        }),
        detail({
          name: '定妆照',
          kind: 'image',
          available: [asset('c')],
          reason: 'over_limit',
        }),
      ],
      { video: 2, audio: 1 },
    )
    expect(r.unsent?.map((item) => item.message)).toEqual([
      '「预告片」的参考视频超过模型上限 2 段，未送入',
      '「配乐」的参考音频超过模型上限 1 段，未送入',
      '「定妆照」的图片超过模型参考上限 9 张，未送入',
    ])
  })

  it('媒体上限未知时不写段数', () => {
    const r = preview([
      detail({
        name: '预告片',
        kind: 'prop',
        media: 'video',
        available: [asset('a')],
        reason: 'over_limit',
      }),
    ])
    expect(r.unsent?.map((item) => item.message)).toEqual([
      '「预告片」的参考视频超过模型上限，未送入',
    ])
  })
})
