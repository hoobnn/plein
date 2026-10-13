import { imageNode, propNode, speechNode, videoNode } from '@plein/nodes'
import {
  connect,
  createDoc,
  createElement,
  type PleinDoc,
  setParams,
  updateElement,
} from '@plein/doc'
import type { PortValue } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import { addCharacter } from '../testing'
import { applyMentions } from './mentions'

/** 造一张角色卡：设定 + 音色（音色按平台存） */
const character = (doc: PleinDoc, name: string, params: Record<string, unknown>, x = 0) =>
  addCharacter(doc, name, params, { x, w: 10, h: 10 })

const node = (doc: PleinDoc, nodeType: string, params: Record<string, unknown>) =>
  createElement(doc, { kind: 'node', nodeType, params, x: 0, y: 300, w: 10, h: 10 })

/** 参考图收集：资产卡连进来的图就是它的参考图（与 runs.collectInputs 一样带上来源元素） */
const collect = (doc: PleinDoc) => async (id: string) => {
  const refs: PortValue[] = []
  for (const e of doc.edges())
    if (e.to[0] === id)
      refs.push({
        type: 'image',
        assetId: doc.get(e.from[0])!.assetId!,
        kind: 'image',
        source: e.from[0],
      })
  return { references: refs }
}

describe('运行前解析 @ 引用', () => {
  const setup = (voice: unknown = { provider: 'plein/mock', voiceId: 'v_linxia' }) => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const photo = createElement(doc, {
      kind: 'image',
      name: '定妆照',
      assetId: 'a'.repeat(64),
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    })
    const hero = character(doc, '林夏', { description: '二十岁，短发', voice }, 200)
    connect(doc, [photo, 'image'], [hero, 'references'])
    return { doc, photo, hero }
  }

  it('图片节点：替换名字、附设定、并入参考图并去重', async () => {
    const { doc, photo } = setup()
    const n = node(doc, 'plein/image', { prompt: '@林夏站在天台，参考@定妆照' })
    const r = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc))
    expect(r.params.prompt).toBe('林夏站在天台，参考定妆照\n\n设定：\n林夏：二十岁，短发')
    expect(r.inputs.references).toEqual([
      {
        type: 'image',
        assetId: doc.get(photo)!.assetId,
        kind: 'image',
        source: doc.get(photo)!.id,
      },
    ])
  })

  it('实际引用：元素名与真正送进去的 assetId 一并给出', async () => {
    const { doc, photo, hero } = setup()
    const n = node(doc, 'plein/image', { prompt: '@林夏，参考@定妆照' })
    const r = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc))
    expect(r.refs).toEqual([
      // 角色卡：送进去的是它自己连着的参考图
      { name: '林夏', elementId: doc.get(hero)!.id, assetIds: [doc.get(photo)!.assetId] },
      // 图片元素：送进去的是它自己
      { name: '定妆照', elementId: doc.get(photo)!.id, assetIds: [doc.get(photo)!.assetId] },
    ])
    // 执行器靠这个隐藏参数把「本次引用」显示在节点运行状态里
    expect(r.params.usedRefs).toEqual(r.refs)
  })

  it('道具卡和角色卡一样能用 @ 引用', async () => {
    const { doc, hero, photo } = setup()
    const prop = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/prop',
      nodeVersion: 1,
      name: '打火机',
      params: { description: '磨砂黑，铜盖有划痕' },
      x: 400,
      y: 0,
      w: 10,
      h: 10,
    })
    const n = node(doc, 'plein/image', { prompt: '@打火机 在@林夏手里' })
    const r = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc))
    expect(r.params.prompt).toBe(
      '打火机 在林夏手里\n\n设定：\n打火机：磨砂黑，铜盖有划痕\n林夏：二十岁，短发',
    )
    expect(r.refs).toEqual([
      { name: '打火机', elementId: doc.get(prop)!.id, assetIds: [] },
      { name: '林夏', elementId: doc.get(hero)!.id, assetIds: [doc.get(photo)!.assetId] },
    ])
  })

  it('视频节点：图片参考模式把 @ 角色的参考图并入图片；其他模式不送图并提示', async () => {
    const { doc, photo } = setup()
    const n = node(doc, 'plein/video', { prompt: '@林夏回头', mode: 'reference' })
    const ref = await applyMentions(doc, doc.get(n)!, videoNode, {}, collect(doc))
    expect(ref.inputs.images?.map((v) => v.type === 'image' && v.assetId)).toEqual([
      doc.get(photo)!.assetId,
    ])

    setParams(doc, n, { mode: 'image' })
    const first: PortValue = { type: 'image', assetId: 'b'.repeat(64), kind: 'image' }
    const framed = await applyMentions(
      doc,
      doc.get(n)!,
      videoNode,
      { images: [first] },
      collect(doc),
    )
    expect(framed.inputs.images).toEqual([first])
    expect(framed.params.prompt).toContain('林夏：二十岁，短发')
    expect(framed.refs[0]!.assetIds).toEqual([])
    expect(framed.notices).toContain(
      '@ 引用的参考图只在「图片参考」模式下送入模型，当前模式只附文字设定',
    )
  })

  it('没有引用时原样返回', async () => {
    const { doc, hero } = setup()
    const r = await applyMentions(doc, doc.get(hero)!, propNode, {}, collect(doc))
    expect(r.params).toEqual(doc.get(hero)!.params)
    expect(r.refs).toEqual([])
  })

  it('改了角色设定，引用它的节点参数跟着变（下游因此过期）', async () => {
    const { doc, hero } = setup()
    const n = node(doc, 'plein/image', { prompt: '@林夏站在天台' })
    const before = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc))
    setParams(doc, hero, { description: '三十岁，长发' })
    const after = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc))
    expect(before.params.prompt).not.toBe(after.params.prompt)
    expect(after.params.prompt).toContain('林夏：三十岁，长发')
  })
})

describe('重名不静默', () => {
  it('两个同名资产：单名写法报错并给出 #序号', async () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    character(doc, '林夏', { description: '主角，短发' }, 0)
    character(doc, '林夏', { description: '路人，长发' }, 200)
    const n = node(doc, 'plein/image', { prompt: '@林夏站在天台' })
    await expect(applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc))).rejects.toThrow(
      '画布上有 2 个「林夏」，请写成 @林夏#1 或 @林夏#2',
    )
  })

  it('写了 #序号就按序号取，设定不串', async () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const a = character(doc, '林夏', { description: '主角，短发' }, 0)
    const b = character(doc, '林夏', { description: '路人，长发' }, 200)
    // 序号按元素 id 排（各副本一致），不按创建顺序
    const [, second] = [a, b].sort()
    const n = node(doc, 'plein/image', { prompt: '@林夏#2站在天台' })
    const r = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc))
    const desc = doc.get(second!)!.params!.description
    expect(r.params.prompt).toBe(`林夏站在天台\n\n设定：\n林夏#2：${desc}`)
    expect(r.refs).toEqual([{ name: '林夏', elementId: second, assetIds: [] }])
    expect(doc.get(a)!.name).toBe('林夏')
  })

  it('改名后引用断链：提示相近的名字，不当成普通文字', async () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const hero = character(doc, '林夏', { description: '主角，短发' }, 0)
    const n = node(doc, 'plein/image', { prompt: '@林夏站在天台' })
    // 角色卡改名，提示词里的旧名字就断了：说清楚，别悄悄少引用一个人
    updateElement(doc, hero, { name: '林小夏' })
    const r = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc))
    expect(r.params.prompt).toBe('@林夏站在天台')
    expect(r.refs).toEqual([])
    expect(r.notices[0]).toBe(
      '提示词里的 @林夏站在天台 找不到同名资产，可能已被改名为「林小夏」，请改过来',
    )
  })
})

describe('音色按平台沿用', () => {
  const setup = (model: string, voice: unknown) => {
    const doc = createDoc(undefined, { schedule: () => {} })
    character(doc, '林夏', { description: '二十岁', voice }, 0)
    const n = node(doc, 'plein/speech', { text: '@林夏：你来了', model })
    return { doc, n }
  }

  it('同平台：沿用角色音色，不打扰用户', async () => {
    const { doc, n } = setup('plein/mock:echo-speech', {
      provider: 'plein/mock',
      voiceId: 'v_linxia',
    })
    const r = await applyMentions(doc, doc.get(n)!, speechNode, {}, collect(doc))
    expect(r.params.voice).toEqual({ provider: 'plein/mock', voiceId: 'v_linxia' })
    expect(r.notices).toEqual([])
  })

  it('换平台：不沿用，并说清是哪一家、要做什么', async () => {
    const { doc, n } = setup('plein/mock:echo-speech', {
      provider: 'plein/doubao-speech',
      voiceId: 'v_linxia',
    })
    await expect(applyMentions(doc, doc.get(n)!, speechNode, {}, collect(doc))).rejects.toThrow(
      '「林夏」的音色属于 plein/doubao-speech，当前配音模型是 plein/mock，音色不能跨平台使用，请重新选择音色',
    )
  })

  it('旧画布的裸字符串音色：照用，但说明无法校验', async () => {
    const { doc, n } = setup('plein/mock:echo-speech', 'v_linxia')
    const r = await applyMentions(doc, doc.get(n)!, speechNode, {}, collect(doc))
    expect(r.params.voice).toEqual({ provider: '', voiceId: 'v_linxia' })
    expect(r.notices[0]).toContain('没有记录属于哪个平台')
  })

  it('手动选过音色：不动用户的设置', async () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    character(doc, '林夏', { description: '二十岁', voice: { provider: 'a/b', voiceId: 'v1' } }, 0)
    const n = node(doc, 'plein/speech', {
      text: '@林夏：你来了',
      model: 'plein/mock:echo-speech',
      voice: { provider: 'plein/mock', voiceId: 'manual' },
    })
    const r = await applyMentions(doc, doc.get(n)!, speechNode, {}, collect(doc))
    expect(r.params.voice).toEqual({ provider: 'plein/mock', voiceId: 'manual' })
  })

  it('引用了多个有音色的角色：交给用户选，不替他挑', async () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    character(doc, '林夏', { description: '', voice: { provider: 'plein/mock', voiceId: 'v1' } }, 0)
    character(
      doc,
      '小夏',
      { description: '', voice: { provider: 'plein/mock', voiceId: 'v2' } },
      200,
    )
    const n = node(doc, 'plein/speech', {
      text: '@林夏 对 @小夏 说',
      model: 'plein/mock:echo-speech',
      voice: '',
    })
    const r = await applyMentions(doc, doc.get(n)!, speechNode, {}, collect(doc))
    expect(r.params.voice).toBe('')
    expect(r.notices[0]).toContain('请在配音节点里手动选择音色')
  })
})

describe('角色档案：@林夏/少年/校服', () => {
  const setup = () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const photo = createElement(doc, {
      kind: 'image',
      name: '定妆照',
      assetId: 'a'.repeat(64),
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    })
    const hero = character(doc, '林夏', { description: '二十岁，短发' }, 200)
    connect(doc, [photo, 'image'], [hero, 'references'])
    return { doc, photo, hero }
  }

  const look = (id: string, name: string, images: string[] = [], description = '') => ({
    id,
    name,
    aliases: [],
    description,
    images,
  })
  const profile = {
    periods: [
      {
        ...look('p1', '少年', ['1'.repeat(64)], '十五岁'),
        voice: { provider: 'plein/mock', voiceId: 'v_young' },
        voiceStates: [
          {
            id: 's1',
            name: '生病',
            aliases: [],
            voice: { provider: 'plein/mock', voiceId: 'v_sick' },
          },
        ],
        outfits: [look('o1', '校服', ['2'.repeat(64)], '蓝白校服')],
      },
    ],
    expressions: [],
  }

  it('图片节点：时期与服饰的设定附上，图排在卡片参考图前面', async () => {
    const { doc, photo, hero } = setup()
    setParams(doc, hero, { profile })
    const n = node(doc, 'plein/image', { prompt: '@林夏/少年/校服站在天台' })
    const r = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc))
    expect(r.params.prompt).toBe(
      '林夏（少年·校服）站在天台\n\n设定：\n林夏（少年·校服）：二十岁，短发\n少年时期：十五岁\n服饰「校服」：蓝白校服',
    )
    expect(r.inputs.references?.map((v) => ('assetId' in v ? v.assetId : ''))).toEqual([
      '1'.repeat(64),
      '2'.repeat(64),
      doc.get(photo)!.assetId,
    ])
  })

  it('配音：状态次音色优先于时期主音色', async () => {
    const { doc, hero } = setup()
    setParams(doc, hero, { profile })
    const sick = node(doc, 'plein/speech', { model: 'plein/mock:tts', text: '@林夏/生病 咳咳' })
    const r = await applyMentions(doc, doc.get(sick)!, speechNode, {}, collect(doc))
    expect(r.params.voice).toEqual({ provider: 'plein/mock', voiceId: 'v_sick' })
    const young = node(doc, 'plein/speech', { model: 'plein/mock:tts', text: '@林夏/少年 你好' })
    const r2 = await applyMentions(doc, doc.get(young)!, speechNode, {}, collect(doc))
    expect(r2.params.voice).toEqual({ provider: 'plein/mock', voiceId: 'v_young' })
  })

  it('对不上的档案项给提示，文本原样保留', async () => {
    const { doc, hero } = setup()
    setParams(doc, hero, { profile })
    const n = node(doc, 'plein/image', { prompt: '@林夏/学生装' })
    const r = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc))
    expect(r.params.prompt).toMatch(/^林夏\/学生装/)
    expect(r.notices.join()).toContain('学生装')
  })
})
