import { videoNode } from '@plein/nodes'
import { connect, createDoc, createElement, setParams, type PleinDoc } from '@plein/doc'
import type { PortValue } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import { addNode } from '../testing'
import { applyMentions } from './mentions'

const asset = (tag: string) => tag.repeat(64)

/** 视频 / 音频元素：可被 @ 引用，也能连进别的节点 */
const media = (doc: PleinDoc, kind: 'video' | 'audio', name: string, tag: string, x = 0) =>
  createElement(doc, { kind, name, assetId: asset(tag), x, y: 0, w: 10, h: 10 })

/** 特效卡：它的 references 端口连进来的就是参考视频 */
const effect = (doc: PleinDoc, name: string) =>
  addNode(doc, 'plein/effect', {
    name,
    params: { description: '镜头怎么动' },
    x: 0,
    y: 200,
  })

/** 参考素材收集：连进 references 端口的媒体元素按自己的类型返回 */
const collect = (doc: PleinDoc) => async (id: string) => {
  const references: PortValue[] = []
  for (const e of doc.edges()) {
    if (e.to[0] !== id) continue
    const src = doc.get(e.from[0])!
    if (src.kind !== 'video' && src.kind !== 'audio') continue
    references.push({
      type: src.kind,
      assetId: src.assetId!,
      kind: src.kind,
      source: e.from[0],
    })
  }
  return { references }
}

const msg = (issues: Array<{ message: string }>) => issues.map((i) => i.message)
const sentIds = (values: PortValue[] | undefined) =>
  values?.map((v) => ('assetId' in v ? v.assetId : ''))

describe('多模态参考的视频 / 音频按名额取舍', () => {
  it('特效卡的参考视频超过上限：送得下的留下，其余舍弃并提示，不阻断', async () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const card = effect(doc, '爆炸')
    for (const [index, tag] of ['a', 'b', 'c'].entries())
      connect(
        doc,
        [media(doc, 'video', `片段${index}`, tag, index * 100), 'video'],
        [card, 'references'],
      )
    const n = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/video',
      params: { prompt: '@爆炸', mode: 'reference' },
      x: 0,
      y: 400,
      w: 10,
      h: 10,
    })
    const r = await applyMentions(
      doc,
      doc.get(n)!,
      videoNode,
      {},
      collect(doc),
      undefined,
      undefined,
      { video: 1, audio: 0 },
    )
    expect(r.blocked).toEqual([])
    // 名额只有 1 段：先放第一条，其余的送不进去
    expect(sentIds(r.inputs.videos)).toEqual([asset('a')])
    const detail = r.details.find((d) => d.elementId === card)
    expect(detail?.sent).toEqual([asset('a')])
    expect(detail?.reason).toBe('over_limit')
    const dropped = r.notices.filter((n) => n.code === 'optional_dropped')
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.message).toBe('这个模型最多带 1 段参考视频，爆炸 的参考视频没有送入')
  })

  it('必需参考放不下：阻断并说明是必需参考', async () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const card = effect(doc, '爆炸')
    connect(doc, [media(doc, 'video', '片段', 'a'), 'video'], [card, 'references'])
    // 节点自己已经连了 1 段视频，名额被占满
    media(doc, 'video', '自己的视频', 'z', 200)
    const n = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/video',
      params: { prompt: '@爆炸', mode: 'reference', requiredRefs: [card] },
      x: 0,
      y: 400,
      w: 10,
      h: 10,
    })
    const ownValue: PortValue = { type: 'video', assetId: asset('z'), kind: 'video' }
    const r = await applyMentions(
      doc,
      doc.get(n)!,
      videoNode,
      { videos: [ownValue] },
      collect(doc),
      undefined,
      undefined,
      { video: 1, audio: 0 },
    )
    expect(r.blocked).toHaveLength(1)
    expect(r.blocked[0]).toMatchObject({ code: 'required_over_limit', elementId: card })
    expect(r.blocked[0]?.message).toBe(
      '「爆炸」是必需参考，但这个模型最多带 1 段参考视频，放不下了，请减少必需参考或换模型',
    )
    // 自己的那一段仍然占名额，没有被偷偷丢掉
    expect(sentIds(r.inputs.videos)).toEqual([asset('z')])
  })

  it('引用顺序：必需参考先占名额，可选参考按出现顺序', async () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const first = media(doc, 'video', '第一段', 'a')
    const second = media(doc, 'video', '第二段', 'b', 100)
    const third = media(doc, 'video', '第三段', 'c', 200)
    const n = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/video',
      params: {
        prompt: '@第一段 @第二段 @第三段',
        mode: 'reference',
        requiredRefs: [third],
      },
      x: 0,
      y: 400,
      w: 10,
      h: 10,
    })
    const r = await applyMentions(
      doc,
      doc.get(n)!,
      videoNode,
      {},
      collect(doc),
      undefined,
      undefined,
      { video: 1, audio: 0 },
    )
    // 名额 1：必需参考先放
    expect(sentIds(r.inputs.videos)).toEqual([asset('c')])
    expect(r.blocked).toEqual([])
    expect(msg(r.notices)).toContain(
      '这个模型最多带 1 段参考视频，第一段、第二段 的参考视频没有送入',
    )
    expect(first && second && third).toBeTruthy()
  })

  it('参考音频同样按名额取舍', async () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    media(doc, 'audio', '第一段', 'a')
    media(doc, 'audio', '第二段', 'b', 100)
    const n = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/video',
      params: { prompt: '@第一段 @第二段', mode: 'reference' },
      x: 0,
      y: 400,
      w: 10,
      h: 10,
    })
    const r = await applyMentions(
      doc,
      doc.get(n)!,
      videoNode,
      {},
      collect(doc),
      undefined,
      undefined,
      { video: 0, audio: 1 },
    )
    expect(sentIds(r.inputs.audios)).toEqual([asset('a')])
    expect(r.notices.filter((n) => n.code === 'optional_dropped')).toHaveLength(1)
    expect(r.notices.find((n) => n.code === 'optional_dropped')?.message).toBe(
      '这个模型最多带 1 段参考音频，第二段 的参考音频没有送入',
    )
  })

  it('模型不支持参考视频（名额为 0）：必需参考阻断，可选参考提示没送入', async () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const clip = media(doc, 'video', '第一段', 'a')
    const n = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/video',
      params: { prompt: '@第一段', mode: 'reference' },
      x: 0,
      y: 400,
      w: 10,
      h: 10,
    })
    const optional = await applyMentions(
      doc,
      doc.get(n)!,
      videoNode,
      {},
      collect(doc),
      undefined,
      undefined,
      { video: 0, audio: 0 },
    )
    expect(optional.blocked).toEqual([])
    expect(optional.details[0]?.reason).toBe('unsupported')
    expect(optional.details[0]?.sent).toEqual([])
    expect(optional.inputs.videos).toBeUndefined()
    const notice = optional.notices.find((n) => n.code === 'unsupported_refs')
    expect(notice?.message).toBe('当前模型不支持参考视频，第一段 的参考视频没有送入')

    // 同样的引用设为必需：不能悄悄丢掉，要阻断说明原因
    setParams(doc, n, { prompt: '@第一段', mode: 'reference', requiredRefs: [clip] })
    const required = await applyMentions(
      doc,
      doc.get(n)!,
      videoNode,
      {},
      collect(doc),
      undefined,
      undefined,
      { video: 0, audio: 0 },
    )
    expect(required.blocked).toHaveLength(1)
    expect(required.blocked[0]).toMatchObject({
      code: 'required_unsupported',
      elementId: clip,
    })
    expect(required.blocked[0]?.message).toBe(
      '「第一段」是必需参考，但当前模型不支持参考视频，请取消必需或换模型',
    )
  })

  it('模型不支持参考音频（名额为 0）：必需参考阻断，可选参考提示没送入', async () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const clip = media(doc, 'audio', '第一段', 'a')
    const n = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/video',
      params: { prompt: '@第一段', mode: 'reference' },
      x: 0,
      y: 400,
      w: 10,
      h: 10,
    })
    const optional = await applyMentions(
      doc,
      doc.get(n)!,
      videoNode,
      {},
      collect(doc),
      undefined,
      undefined,
      { video: 0, audio: 0 },
    )
    expect(optional.blocked).toEqual([])
    expect(optional.details[0]?.reason).toBe('unsupported')
    expect(optional.details[0]?.sent).toEqual([])
    expect(optional.inputs.audios).toBeUndefined()
    const notice = optional.notices.find((n) => n.code === 'unsupported_refs')
    expect(notice?.message).toBe('当前模型不支持参考音频，第一段 的参考音频没有送入')

    setParams(doc, n, { prompt: '@第一段', mode: 'reference', requiredRefs: [clip] })
    const required = await applyMentions(
      doc,
      doc.get(n)!,
      videoNode,
      {},
      collect(doc),
      undefined,
      undefined,
      { video: 0, audio: 0 },
    )
    expect(required.blocked).toHaveLength(1)
    expect(required.blocked[0]).toMatchObject({
      code: 'required_unsupported',
      elementId: clip,
    })
    expect(required.blocked[0]?.message).toBe(
      '「第一段」是必需参考，但当前模型不支持参考音频，请取消必需或换模型',
    )
  })
})
