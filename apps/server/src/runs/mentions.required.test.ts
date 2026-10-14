import { imageNode, videoNode } from '@plein/nodes'
import { connect, createDoc, createElement, type PleinDoc, updateElement } from '@plein/doc'
import type { PortValue } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import { addNode } from '../testing'
import { applyMentions } from './mentions'

/** 资产卡连进来的图就是它的参考图（与 runs.collectInputs 一样带上来源元素） */
const collect = (doc: PleinDoc) => async (id: string) => {
  const refs: PortValue[] = []
  for (const e of doc.edges())
    if (e.to[0] === id)
      refs.push({ type: 'image', assetId: doc.get(e.from[0])!.assetId!, kind: 'image' })
  return { references: refs }
}

const asset = (c: string) => c.repeat(64)

/** 一张资产卡；asset 为空时没有参考图 */
function card(doc: PleinDoc, nodeType: string, name: string, image: string | null, x: number) {
  const id = addNode(doc, nodeType, { name, params: { description: `${name}的设定` }, x, y: 100 })
  if (image) {
    const img = createElement(doc, { kind: 'image', assetId: image, x, y: 0, w: 10, h: 10 })
    connect(doc, [img, 'image'], [id, 'references'])
  }
  return id
}

function scene(opts: { keyImage?: boolean } = {}) {
  const doc = createDoc(undefined, { schedule: () => {} })
  const hero = card(doc, 'plein/character', '林夏', asset('a'), 0)
  const roof = card(doc, 'plein/scene', '天台', asset('b'), 300)
  const box = card(doc, 'plein/prop', '铁盒', asset('c'), 600)
  const key = card(doc, 'plein/prop', '钥匙', opts.keyImage === false ? null : asset('d'), 900)
  return { doc, hero, roof, box, key }
}

const shot = (doc: PleinDoc, nodeType: string, params: Record<string, unknown>) =>
  createElement(doc, { kind: 'node', nodeType, params, x: 0, y: 400, w: 10, h: 10 })

const sent = (values: PortValue[] | undefined) =>
  (values ?? []).map((v) => (v as { assetId: string }).assetId)

describe('必需参考与取舍', () => {
  it('默认全部可选：按角色、场景、道具取舍，舍弃的记录原因', async () => {
    const { doc, box, key } = scene()
    const n = shot(doc, 'plein/image', { prompt: '@林夏 @天台 @铁盒 @钥匙' })
    const r = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc), 3)
    expect(sent(r.inputs.references)).toEqual([asset('a'), asset('b'), asset('c')])
    expect(r.blocked).toEqual([])
    const detail = (id: string) => r.details.find((d) => d.elementId === id)!
    expect(detail(box)).toMatchObject({ kind: 'prop', required: false, sent: [asset('c')] })
    expect(detail(box).reason).toBeUndefined()
    expect(detail(key)).toMatchObject({
      kind: 'prop',
      required: false,
      available: [asset('d')],
      sent: [],
      reason: 'over_limit',
    })
  })

  it('关键道具设为必需：模型只收三张时保住它，舍弃排在后面的可选参考', async () => {
    const { doc, roof, key } = scene()
    const n = shot(doc, 'plein/image', { prompt: '@林夏 @天台 @铁盒 @钥匙', requiredRefs: [key] })
    const r = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc), 3)
    // 送入顺序仍按提示词里的顺序，取舍按优先级
    expect(sent(r.inputs.references)).toEqual([asset('a'), asset('b'), asset('d')])
    expect(r.details.find((d) => d.elementId === key)).toMatchObject({
      required: true,
      sent: [asset('d')],
    })
    expect(r.details.find((d) => d.elementId === roof)!.sent).toEqual([asset('b')])
    expect(r.notices.join()).toContain('铁盒 的参考图没有送入')
    expect(r.blocked).toEqual([])
  })

  it('必需参考没有图：阻断；可选参考没有图：只附文字并记为 no_image', async () => {
    const { doc, key } = scene({ keyImage: false })
    const optional = shot(doc, 'plein/image', { prompt: '@林夏 @钥匙' })
    const r1 = await applyMentions(doc, doc.get(optional)!, imageNode, {}, collect(doc), 3)
    expect(r1.blocked).toEqual([])
    expect(r1.details.find((d) => d.elementId === key)).toMatchObject({ reason: 'no_image' })
    expect(r1.params.prompt).toContain('钥匙：钥匙的设定')

    const required = shot(doc, 'plein/image', { prompt: '@林夏 @钥匙', requiredRefs: [key] })
    const r2 = await applyMentions(doc, doc.get(required)!, imageNode, {}, collect(doc), 3)
    expect(r2.blocked).toHaveLength(1)
    expect(r2.blocked[0]).toContain('「钥匙」是必需参考')
  })

  it('必需参考超过模型上限：阻断，不悄悄舍弃', async () => {
    const { doc, hero, roof, box } = scene()
    const n = shot(doc, 'plein/image', {
      prompt: '@林夏 @天台 @铁盒',
      requiredRefs: [box, roof, hero],
    })
    const r = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc), 2)
    expect(r.blocked).toHaveLength(1)
    // 先后顺序：铁盒、天台先放，林夏放不下
    expect(r.blocked[0]).toContain('「林夏」是必需参考，但这个模型最多带 2 张参考图')
  })

  it('生成视频不在「图片参考」模式：可选参考记为 unsupported，必需参考阻断', async () => {
    const { doc, box } = scene()
    const optional = shot(doc, 'plein/video', { prompt: '@林夏 @铁盒', mode: 'text' })
    const r1 = await applyMentions(doc, doc.get(optional)!, videoNode, {}, collect(doc))
    expect(r1.blocked).toEqual([])
    expect(r1.details.every((d) => d.reason === 'unsupported' && d.sent.length === 0)).toBe(true)

    const required = shot(doc, 'plein/video', {
      prompt: '@林夏 @铁盒',
      mode: 'text',
      requiredRefs: [box],
    })
    const r2 = await applyMentions(doc, doc.get(required)!, videoNode, {}, collect(doc))
    expect(r2.blocked[0]).toContain('当前模式不送参考图')
  })

  it('改名后必需参考仍按元素对应', async () => {
    const { doc, key } = scene()
    updateElement(doc, key, { name: '旧钥匙' })
    const n = shot(doc, 'plein/image', { prompt: '@林夏 @天台 @铁盒 @旧钥匙', requiredRefs: [key] })
    const r = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc), 3)
    expect(r.details.find((d) => d.elementId === key)).toMatchObject({
      name: '旧钥匙',
      required: true,
      sent: [asset('d')],
    })
  })
})
