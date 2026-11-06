import { imageNode, llmNode, propNode, speechNode, videoNode } from '@plein/nodes'
import {
  connect,
  createDoc,
  createElement,
  type PleinDoc,
  setParams,
  updateElement,
} from '@plein/doc'
import { type PortValue, referenceLabelStyle, referenceMediaLabel } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import { addCharacter, addNode } from '../testing'
import { applyMentions } from './mentions'

/** 方舟图片编号去掉前导 @（编号写法随 modelbay 升级变化，测试不写死） */
const arkImage = (index: number) =>
  referenceMediaLabel(referenceLabelStyle('video.generate', 'volc/ark'), 'image', index).replace(
    /^@/,
    '',
  )

const msg = (issues: Array<{ message: string }>) => issues.map((i) => i.message)

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

  it('邮箱和转义文案不引入同名角色设定、参考图或断链提示', async () => {
    const { doc, hero } = setup()
    updateElement(doc, hero, { name: 'example.com' })
    const prompt = '联系 test@example.com；说明 \\@example.com；@@example.com'
    const n = node(doc, 'plein/image', { prompt })
    const r = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc))
    expect(r.params.prompt).toBe(prompt)
    expect(r.refs).toEqual([])
    expect(r.inputs).toEqual({})
    expect(r.notices).toEqual([])
  })

  it('图片节点：替换名字、并入参考图并去重，不追加文字设定', async () => {
    const { doc, photo } = setup()
    const n = node(doc, 'plein/image', { prompt: '@林夏站在天台，参考@定妆照' })
    const r = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc))
    expect(r.params.prompt).toBe('林夏（图1）站在天台，参考图1')
    expect(r.inputs.references).toEqual([
      {
        type: 'image',
        assetId: doc.get(photo)!.assetId,
        kind: 'image',
        source: doc.get(photo)!.id,
      },
    ])
  })

  it('图片节点：正文按最终去重顺序编号，未送入的引用只保留名字', async () => {
    const { doc, photo, hero } = setup()
    const second = createElement(doc, {
      kind: 'image',
      assetId: 'b'.repeat(64),
      x: 100,
      y: 0,
      w: 10,
      h: 10,
    })
    connect(doc, [second, 'image'], [hero, 'references'])
    createElement(doc, {
      kind: 'node',
      nodeType: 'plein/prop',
      name: '铁盒',
      params: { description: '磨砂黑' },
      x: 400,
      y: 0,
      w: 10,
      h: 10,
    })
    const n = node(doc, 'plein/image', { prompt: '@林夏带着@铁盒，参考@定妆照' })
    const own: PortValue = { type: 'image', assetId: 'c'.repeat(64), kind: 'image' }
    const r = await applyMentions(doc, doc.get(n)!, imageNode, { references: [own] }, collect(doc))
    expect(r.inputs.references?.map((v) => ('assetId' in v ? v.assetId : ''))).toEqual([
      'c'.repeat(64),
      doc.get(photo)!.assetId,
      'b'.repeat(64),
    ])
    expect(r.params.prompt).toBe('林夏（图2、图3）带着铁盒，参考图2')
    expect(r.params.prompt).not.toContain('参考对应')
  })

  it('同一引用重复送入同一资产时只列一个参考图序号', async () => {
    const { doc, photo, hero } = setup()
    const duplicate = createElement(doc, {
      kind: 'image',
      assetId: doc.get(photo)!.assetId,
      x: 100,
      y: 0,
      w: 10,
      h: 10,
    })
    connect(doc, [duplicate, 'image'], [hero, 'references'])
    const n = node(doc, 'plein/image', { prompt: '@林夏站在天台' })
    const r = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc))
    expect(r.details[0]?.sent).toEqual([doc.get(photo)!.assetId, doc.get(photo)!.assetId])
    expect(r.inputs.references).toHaveLength(1)
    expect(r.params.prompt).toBe('林夏（图1）站在天台')
    expect(r.params.prompt).not.toContain('图1、图1')
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
    expect(r.params.prompt).toBe('打火机 在林夏（图1）手里')
    expect(r.refs).toEqual([
      { name: '打火机', elementId: doc.get(prop)!.id, assetIds: [] },
      { name: '林夏', elementId: doc.get(hero)!.id, assetIds: [doc.get(photo)!.assetId] },
    ])
  })

  it('不收参考图的节点：@ 引用的图不算送入，并说明没送进模型', async () => {
    const { doc, photo, hero } = setup()
    const n = node(doc, 'plein/speech', { text: '@林夏 你来了' })
    const r = await applyMentions(doc, doc.get(n)!, speechNode, {}, collect(doc))
    // 这个节点没有参考图端口：引用的图不能算送入，refs 里也不留图
    expect(r.refs).toEqual([{ name: '林夏', elementId: doc.get(hero)!.id, assetIds: [] }])
    expect(r.details[0]?.sent).toEqual([])
    expect(msg(r.notices)).toContain(
      '@ 引用的参考图（林夏）这个节点不送入模型，仅保留提示词中的引用名称，不追加文字设定',
    )
    expect(doc.get(photo)!.assetId).toBeTruthy()
  })

  it('LLM 节点：模型支持看图时把 @ 引用的图并入 images', async () => {
    const { doc, photo, hero } = setup()
    const n = node(doc, 'plein/llm', { model: 'plein/mock:agent-vision', prompt: '@林夏是谁' })
    const r = await applyMentions(
      doc,
      doc.get(n)!,
      llmNode,
      {},
      collect(doc),
      undefined,
      undefined,
      undefined,
      { acceptsImages: true },
    )
    expect(r.inputs.images?.map((v) => ('assetId' in v ? v.assetId : ''))).toEqual([
      doc.get(photo)!.assetId,
    ])
    expect(r.refs).toEqual([
      { name: '林夏', elementId: doc.get(hero)!.id, assetIds: [doc.get(photo)!.assetId] },
    ])
  })

  it('LLM 节点：模型不支持看图时不并图，只保留引用名称并说明', async () => {
    const { doc, photo, hero } = setup()
    const n = node(doc, 'plein/llm', { model: 'plein/mock:chat', prompt: '@林夏是谁' })
    const r = await applyMentions(doc, doc.get(n)!, llmNode, {}, collect(doc))
    expect(r.inputs.images).toBeUndefined()
    expect(r.refs).toEqual([{ name: '林夏', elementId: doc.get(hero)!.id, assetIds: [] }])
    expect(msg(r.notices)).toContain(
      '@ 引用的参考图（林夏）这个节点不送入模型，仅保留提示词中的引用名称，不追加文字设定',
    )
    expect(doc.get(photo)!.assetId).toBeTruthy()
  })

  it('视频节点：多模态参考模式把 @ 角色的参考图并入图片；其他模式不送图并提示', async () => {
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
    expect(framed.params.prompt).not.toContain('二十岁，短发')
    expect(framed.refs[0]!.assetIds).toEqual([])
    expect(msg(framed.notices)).toContain(
      '@ 引用的参考图（林夏）只在「多模态参考」模式下送入模型；当前模式未送入，仅保留提示词中的引用名称，不追加文字设定',
    )
  })

  it('首帧视频：保留参考用途原文，不追加参考对应并在提示中列出未送入的引用', async () => {
    const { doc } = setup()
    const n = node(doc, 'plein/video', {
      prompt: '参考用途：@林夏 只确定面型',
      mode: 'image',
      model: 'minimax/api:MiniMax-H3',
    })
    const first: PortValue = { type: 'image', assetId: 'b'.repeat(64), kind: 'image' }
    const r = await applyMentions(doc, doc.get(n)!, videoNode, { images: [first] }, collect(doc))
    expect(r.params.prompt).toContain('参考用途：林夏 只确定面型')
    expect(r.params.prompt).not.toContain('参考对应：')
    expect(r.inputs.images).toEqual([first])
    const notice = r.notices.find((n) => n.code === 'unsupported_refs')
    expect(notice?.message).toContain('林夏')
    expect(notice?.message).toContain('仅保留提示词中的引用名称，不追加文字设定')
  })

  it('超过模型的参考图上限：先保角色、再场景，放不下的道具不送图、不追加设定', async () => {
    const { doc, hero } = setup()
    const card = (nodeType: string, name: string, asset: string, x: number) => {
      const img = createElement(doc, {
        kind: 'image',
        assetId: asset.repeat(64),
        x,
        y: 0,
        w: 10,
        h: 10,
      })
      const id = addNode(doc, nodeType, {
        name,
        params: { description: `${name}的设定` },
        x,
        y: 100,
        w: 10,
        h: 10,
      })
      connect(doc, [img, 'image'], [id, 'references'])
      return id
    }
    card('plein/prop', '铁盒', 'c', 400)
    card('plein/scene', '天台', 'b', 600)
    const n = node(doc, 'plein/image', { prompt: '@铁盒 @天台 @林夏 打开盒子' })
    const r = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc), 2)
    expect(r.inputs.references?.map((v) => (v as { assetId: string }).assetId)).toEqual([
      'b'.repeat(64),
      'a'.repeat(64),
    ])
    expect(r.params.prompt).not.toContain('铁盒的设定')
    expect(r.params.prompt).not.toContain('铁盒（图')
    expect(r.refs.find((x) => x.name === '铁盒')!.assetIds).toEqual([])
    expect(msg(r.notices)).toContain(
      '这个模型最多带 2 张参考图，铁盒 的参考图没有送入，仅保留引用名称，不追加文字设定',
    )
    expect(hero).toBeTruthy()
  })

  it('多个可选参考超上限时只汇总一条提示', async () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    for (const [index, name] of ['第一张.png', '第二张.png', '第三张.png'].entries())
      createElement(doc, {
        kind: 'image',
        name,
        assetId: String.fromCharCode(97 + index).repeat(64),
        x: index * 100,
        y: 0,
        w: 10,
        h: 10,
      })
    const n = node(doc, 'plein/image', {
      prompt: '@第一张.png @第二张.png @第三张.png',
    })
    const r = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc), 1)
    const dropped = r.notices.filter((notice) => notice.code === 'optional_dropped')
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.message).toBe(
      '这个模型最多带 1 张参考图，第二张.png、第三张.png 的参考图没有送入，仅保留引用名称，不追加文字设定',
    )
  })

  it('没有引用时原样返回', async () => {
    const { doc, hero } = setup()
    const r = await applyMentions(doc, doc.get(hero)!, propNode, {}, collect(doc))
    expect(r.params).toEqual(doc.get(hero)!.params)
    expect(r.refs).toEqual([])
  })

  it('改了角色设定，引用它的节点提示词不变', async () => {
    const { doc, hero } = setup()
    const n = node(doc, 'plein/image', { prompt: '@林夏站在天台' })
    const before = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc))
    setParams(doc, hero, { description: '三十岁，长发' })
    const after = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc))
    expect(before.params.prompt).toBe(after.params.prompt)
    expect(after.params.prompt).not.toContain('三十岁，长发')
  })
})

describe('重名不静默', () => {
  it('两个同名资产：单名写法不猜对象，阻断并给出 #序号，预览照常给出', async () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    character(doc, '林夏', { description: '主角，短发' }, 0)
    character(doc, '林夏', { description: '路人，长发' }, 200)
    const n = node(doc, 'plein/image', { prompt: '@林夏站在天台' })
    // 不再抛错把整个节点打成 unprepared：返回 blocked，提示詞原样保留，不自动改写
    const r = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc))
    expect(r.blocked).toEqual([
      { code: 'prepare_failed', message: '画布上有 2 个「林夏」，请写成 @林夏#1 或 @林夏#2' },
    ])
    expect(r.params.prompt).toBe('@林夏站在天台')
    expect(r.refs).toEqual([])
    expect(r.details).toEqual([])
  })

  it('序号越界（旁路改名后同名变少）：阻断而不是 unprepared，提示改成哪个写法', async () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const first = character(doc, '林夏', { description: '主角，短发' }, 0)
    character(doc, '林夏', { description: '路人，长发' }, 200)
    const n = node(doc, 'plein/image', { prompt: '@林夏#2 回头' })
    // 另一张同名卡改名（不经 renameElement 的旁路），同名集合从 2 变 1，#2 越界
    updateElement(doc, first, { name: '林小夏' })
    const r = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc))
    expect(r.blocked).toEqual([
      { code: 'prepare_failed', message: '「@林夏#2」不存在，画布上「林夏」只有 @林夏' },
    ])
    expect(r.params.prompt).toBe('@林夏#2 回头')
    expect(r.refs).toEqual([])
  })

  it('混着有效引用：有效的照常编号，越界的原文保留', async () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    character(doc, '林夏', { description: '主角，短发' }, 0)
    const wang = character(doc, '小王', { description: '配角' }, 200)
    const photo = createElement(doc, {
      kind: 'image',
      name: '定妆照',
      assetId: 'a'.repeat(64),
      x: 400,
      y: 0,
      w: 10,
      h: 10,
    })
    connect(doc, [photo, 'image'], [wang, 'references'])
    const n = node(doc, 'plein/image', { prompt: '@林夏#2 和 @小王 回头' })
    const r = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc))
    expect(r.blocked).toEqual([
      { code: 'prepare_failed', message: '「@林夏#2」不存在，画布上「林夏」只有 @林夏' },
    ])
    // 越界的 @林夏#2 原文保留（不吞掉 @ 和序号），同句有效的 @小王 照常编号并送图
    expect(r.params.prompt).toBe('@林夏#2 和 小王（图1） 回头')
    expect(r.refs).toEqual([{ name: '小王', elementId: wang, assetIds: ['a'.repeat(64)] }])
  })

  it('文生视频（非参考模式）：消歧失败的引用原文保留，不吞掉 @', async () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    character(doc, '林夏', { description: '主角，短发' }, 0)
    const n = node(doc, 'plein/video', { model: 'plein/mock:video', prompt: '@林夏#2 回头' })
    const r = await applyMentions(doc, doc.get(n)!, videoNode, {}, collect(doc))
    expect(r.blocked).toEqual([
      { code: 'prepare_failed', message: '「@林夏#2」不存在，画布上「林夏」只有 @林夏' },
    ])
    expect(r.params.prompt).toBe('@林夏#2 回头')
    expect(r.refs).toEqual([])
  })

  it('首帧模式（非参考）：越界引用原文保留，同句有效引用照常处理', async () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    character(doc, '林夏', { description: '主角，短发' }, 0)
    character(doc, '小王', { description: '配角' }, 200)
    const n = node(doc, 'plein/video', {
      model: 'plein/mock:video',
      mode: 'image',
      prompt: '@林夏#2 和 @小王 开门',
    })
    const r = await applyMentions(doc, doc.get(n)!, videoNode, {}, collect(doc))
    expect(r.blocked).toEqual([
      { code: 'prepare_failed', message: '「@林夏#2」不存在，画布上「林夏」只有 @林夏' },
    ])
    expect(r.params.prompt).toBe('@林夏#2 和 小王 开门')
  })

  it('写了 #序号就按序号取，不追加任一同名角色设定', async () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const a = character(doc, '林夏', { description: '主角，短发' }, 0)
    const b = character(doc, '林夏', { description: '路人，长发' }, 200)
    // 序号按元素 id 排（各副本一致），不按创建顺序
    const [, second] = [a, b].sort()
    const n = node(doc, 'plein/image', { prompt: '@林夏#2站在天台' })
    const r = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc))
    expect(r.params.prompt).toBe('林夏站在天台')
    expect(r.refs).toEqual([{ name: '林夏#2', elementId: second, assetIds: [] }])
    expect(r.details[0]?.name).toBe('林夏#2')
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
    expect(msg(r.notices)[0]).toBe(
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
    expect(msg(r.notices)).toEqual([])
  })

  it('换平台：不沿用，并说清是哪一家、要做什么', async () => {
    const { doc, n } = setup('volc/ark:speech', {
      provider: 'minimax/api',
      voiceId: 'v_linxia',
    })
    await expect(applyMentions(doc, doc.get(n)!, speechNode, {}, collect(doc))).rejects.toThrow(
      '「林夏」的音色属于 MiniMax，当前配音模型是 火山方舟，音色不能跨平台使用，请重新选择音色',
    )
  })

  it('旧画布的裸字符串音色：照用，但说明无法校验', async () => {
    const { doc, n } = setup('plein/mock:echo-speech', 'v_linxia')
    const r = await applyMentions(doc, doc.get(n)!, speechNode, {}, collect(doc))
    expect(r.params.voice).toEqual({ provider: '', voiceId: 'v_linxia' })
    expect(msg(r.notices)[0]).toContain('没有记录属于哪个平台')
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
    expect(msg(r.notices)[0]).toContain('请在配音节点里手动选择音色')
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

  it('图片节点：时期与服饰只选择参考图，不附文字设定', async () => {
    const { doc, photo, hero } = setup()
    setParams(doc, hero, { profile })
    const n = node(doc, 'plein/image', { prompt: '@林夏/少年/校服站在天台' })
    const r = await applyMentions(doc, doc.get(n)!, imageNode, {}, collect(doc))
    expect(r.params.prompt).toBe('林夏（少年·校服）（图1、图2、图3）站在天台')
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
    expect(r.params.prompt).toMatch(/^林夏（图1）\/学生装/)
    expect(msg(r.notices).join()).toContain('学生装')
  })
})

it('视频角色绑定以最终去重后的参考图顺序编号，保留手写素材标记', async () => {
  const doc = createDoc(undefined, { schedule: () => {} })
  const photo = createElement(doc, {
    kind: 'image',
    name: '角色照',
    assetId: 'a'.repeat(64),
    x: 0,
    y: 0,
    w: 10,
    h: 10,
  })
  const hero = character(doc, '林夏', { description: '短发' })
  connect(doc, [photo, 'image'], [hero, 'references'])
  const n = node(doc, 'plein/video', {
    prompt: '@林夏 参考 @video1 运镜',
    mode: 'reference',
    model: 'volc/ark:doubao-seedance-2-5-260628',
  })
  const own: PortValue = { type: 'image', assetId: 'b'.repeat(64), kind: 'image' }
  const result = await applyMentions(doc, doc.get(n)!, videoNode, { images: [own] }, collect(doc))
  expect(result.params.prompt).toContain(`林夏@${arkImage(2)}`)
  expect(result.params.prompt).toContain('@video1')
  const reversed = await applyMentions(
    doc,
    doc.get(n)!,
    videoNode,
    { images: [{ type: 'image', assetId: 'a'.repeat(64), kind: 'image' }, own] },
    collect(doc),
  )
  expect(reversed.params.prompt).toContain(`林夏@${arkImage(1)}`)
  expect(reversed.inputs.images).toHaveLength(2)
})
