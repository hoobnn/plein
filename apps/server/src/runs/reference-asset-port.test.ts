import { connect, createElement } from '@plein/doc'
import { referenceLabelStyle, referenceMediaLabel } from '@plein/plugin-sdk'
import { mockProvider } from '@plein/providers'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import type { Server } from '../app'
import { addNode, bootServer, createCanvas, mockSettings } from '../testing'

const videoSpec = mockProvider.models.find((model) => model.id === 'video')!
const videoLimits = videoSpec.limits
afterEach(() => {
  videoSpec.limits = videoLimits
  vi.restoreAllMocks()
})

const asset = (c: string) => c.repeat(64)
const boundary = (name: string, source: string) =>
  `referenceNameBinding:${encodeURIComponent(name)}:${source}`
const label = (kind: 'image' | 'video' | 'audio', n = 1) =>
  referenceMediaLabel(referenceLabelStyle('video.generate', 'plein'), kind, n)

async function boot() {
  const { server } = await bootServer()
  mockSettings(server, { latencyMs: 0 })
  const { id, doc } = await createCanvas(server)
  return { server, id, doc }
}

function target(doc: Awaited<ReturnType<typeof boot>>['doc'], prompt: string, bindings = {}) {
  return addNode(doc, 'plein/video', {
    params: { model: 'plein/mock:video', mode: 'reference', prompt, ...bindings },
    x: 600,
  })
}

async function submitted(
  server: Server,
  canvas: string,
  node: string,
  spy: ReturnType<typeof vi.spyOn>,
) {
  const run = server.runs.start(canvas, node, 'local')
  expect(await server.runs.wait(run)).toBe('succeeded')
  const calls = spy.mock.calls as Array<[{ capability?: string; input: unknown }]>
  const call = calls.find(([request]) => request.capability === 'video.generate')
  expect(call).toBeTruthy()
  return call![0].input as { references?: Array<{ assetId: string }> }
}

it.each([
  ['image', 'images'],
  ['video', 'videos'],
  ['audio', 'audios'],
] as const)('未连线的 %s 素材按持久绑定进入实际输入与提交', async (kind, port) => {
  const { server, id, doc } = await boot()
  const media = createElement(doc, {
    id: `${kind}-asset`,
    kind,
    name: '素材',
    assetId: asset(kind[0]!),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const node = target(doc, '@素材 舞蹈', {
    [boundary('素材', media)]: {
      type: kind,
      assetId: asset(kind[0]!),
      source: media,
      sourcePort: kind,
    },
  })
  const submit = vi.spyOn(mockProvider, 'submit')
  const input = await server.runs.preview(id, node, 'local')
  expect(input.status).toBe('ready')
  expect(input.inputs[port]).toMatchObject([
    { assetId: asset(kind[0]!), source: media, sourcePort: kind },
  ])
  expect(input.prompt).toContain(label(kind))
  expect(input.prompt).not.toContain('@素材')
  expect(input.refs.find((ref) => ref.elementId === media)?.sent).toEqual([asset(kind[0]!)])
  const posted = await submitted(server, id, node, submit)
  expect(posted.references?.some((item) => item.assetId === asset(kind[0]!))).toBe(true)
})

it('旧的无输出口单素材绑定仍按唯一来源匹配', async () => {
  const { server, id, doc } = await boot()
  const media = createElement(doc, {
    id: 'legacy',
    kind: 'image',
    name: '旧图',
    assetId: asset('l'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const node = target(doc, '@旧图 舞蹈', {
    [boundary('旧图', media)]: { type: 'image', assetId: asset('l'), source: media },
  })
  const input = await server.runs.preview(id, node, 'local')
  expect(input.status).toBe('ready')
  expect(input.inputs.images).toMatchObject([{ assetId: asset('l'), source: media }])
  expect(input.prompt).toContain(label('image'))
})

it('同名素材只送绑定指向的那一张', async () => {
  const { server, id, doc } = await boot()
  const first = createElement(doc, {
    id: 'a',
    kind: 'image',
    name: '图',
    assetId: asset('a'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const second = createElement(doc, {
    id: 'b',
    kind: 'image',
    name: '图',
    assetId: asset('b'),
    x: 0,
    y: 200,
    w: 100,
    h: 100,
  })
  const node = target(doc, '@图#2 舞蹈', {
    [boundary('图#2', second)]: {
      type: 'image',
      assetId: asset('b'),
      source: second,
      sourcePort: 'image',
    },
  })
  const submit = vi.spyOn(mockProvider, 'submit')
  const input = await server.runs.preview(id, node, 'local')
  expect(input.status).toBe('ready')
  expect(input.inputs.images).toMatchObject([{ assetId: asset('b'), source: second }])
  expect(input.refs.find((ref) => ref.elementId === second)?.sent).toEqual([asset('b')])
  expect(input.inputs.images?.some((item) => item.assetId === asset('a'))).toBe(false)
  const posted = await submitted(server, id, node, submit)
  expect(posted.references?.some((item) => item.assetId === asset('b'))).toBe(true)
  expect(posted.references?.some((item) => item.assetId === asset('a'))).toBe(false)
  void first
})

it('输出口对不上或来源已删除时不按名字接管', async () => {
  const { server, id, doc } = await boot()
  const media = createElement(doc, {
    id: 'wrong-port',
    kind: 'image',
    name: '素材',
    assetId: asset('w'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const node = target(doc, '@素材 舞蹈', {
    [boundary('素材', media)]: {
      type: 'image',
      assetId: asset('w'),
      source: media,
      sourcePort: 'lastFrame',
    },
  })
  const input = await server.runs.preview(id, node, 'local')
  expect(input.status).not.toBe('ready')
  expect(input.inputs.images ?? []).toEqual([])
  expect(input.blocked.some((issue) => issue.message.includes('重新选择'))).toBe(true)

  const gone = target(doc, '@素材 舞蹈', {
    [boundary('素材', 'gone')]: {
      type: 'image',
      assetId: asset('g'),
      source: 'gone',
      sourcePort: 'image',
    },
  })
  const stale = await server.runs.preview(id, gone, 'local')
  expect(stale.inputs.images ?? []).toEqual([])
  expect(stale.notices.some((notice) => notice.code === 'stale_binding')).toBe(true)
  connect(doc, [media, 'image'], [node, 'images'])
})

it('绑定后新增同名素材仍按来源 id 送原图，不由首个同名替代', async () => {
  const { server, id, doc } = await boot()
  const original = createElement(doc, {
    id: 'b',
    kind: 'image',
    name: '图',
    assetId: asset('b'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const node = target(doc, '@图 舞蹈', {
    [boundary('图', original)]: {
      type: 'image',
      assetId: asset('b'),
      source: original,
      sourcePort: 'image',
    },
  })
  const before = await server.runs.preview(id, node, 'local')
  expect(before.status).toBe('ready')
  expect(before.inputs.images).toMatchObject([{ assetId: asset('b'), source: original }])

  // 绑定之后才出现同名素材：正文、绑定键都不变，仍按来源 id 送原图。
  createElement(doc, {
    id: 'a',
    kind: 'image',
    name: '图',
    assetId: asset('a'),
    x: 0,
    y: 200,
    w: 100,
    h: 100,
  })
  const submit = vi.spyOn(mockProvider, 'submit')
  const input = await server.runs.preview(id, node, 'local')
  expect(input.status).toBe('ready')
  expect(input.inputs.images).toMatchObject([{ assetId: asset('b'), source: original }])
  expect(input.inputs.images?.some((item) => item.assetId === asset('a'))).toBe(false)
  const posted = await submitted(server, id, node, submit)
  expect(posted.references?.some((item) => item.assetId === asset('b'))).toBe(true)
  expect(posted.references?.some((item) => item.assetId === asset('a'))).toBe(false)
})

it('多个未连线绑定按正文顺序进入实际输入与提交', async () => {
  const { server, id, doc } = await boot()
  const first = createElement(doc, {
    id: 'first',
    kind: 'image',
    name: '甲',
    assetId: asset('a'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const second = createElement(doc, {
    id: 'second',
    kind: 'image',
    name: '乙',
    assetId: asset('b'),
    x: 0,
    y: 200,
    w: 100,
    h: 100,
  })
  const node = target(doc, '@甲 与 @乙', {
    [boundary('甲', first)]: {
      type: 'image',
      assetId: asset('a'),
      source: first,
      sourcePort: 'image',
    },
    [boundary('乙', second)]: {
      type: 'image',
      assetId: asset('b'),
      source: second,
      sourcePort: 'image',
    },
  })
  const submit = vi.spyOn(mockProvider, 'submit')
  const input = await server.runs.preview(id, node, 'local')
  expect(input.status).toBe('ready')
  expect(input.inputs.images?.map((item) => item.assetId)).toEqual([asset('a'), asset('b')])
  const posted = await submitted(server, id, node, submit)
  expect(
    posted.references
      ?.map((item) => item.assetId)
      .filter((id) => id === asset('a') || id === asset('b')),
  ).toEqual([asset('a'), asset('b')])
  const firstLabel = input.prompt?.indexOf(label('image', 1)) ?? -1
  const secondLabel = input.prompt?.indexOf(label('image', 2)) ?? -1
  expect(firstLabel).toBeGreaterThanOrEqual(0)
  expect(secondLabel).toBeGreaterThan(firstLabel)
})

it('普通 @ 与持久绑定混排按正文位置合流', async () => {
  const { server, id, doc } = await boot()
  const plain = createElement(doc, {
    id: 'plain',
    kind: 'image',
    name: '丙',
    assetId: asset('c'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const bound = createElement(doc, {
    id: 'bound',
    kind: 'image',
    name: '乙',
    assetId: asset('b'),
    x: 0,
    y: 200,
    w: 100,
    h: 100,
  })
  const node = target(doc, '@丙 与 @乙', {
    [boundary('乙', bound)]: {
      type: 'image',
      assetId: asset('b'),
      source: bound,
      sourcePort: 'image',
    },
  })
  const submit = vi.spyOn(mockProvider, 'submit')
  const input = await server.runs.preview(id, node, 'local')
  expect(input.status).toBe('ready')
  expect(input.inputs.images?.map((item) => item.assetId)).toEqual([asset('c'), asset('b')])
  const posted = await submitted(server, id, node, submit)
  expect(
    posted.references
      ?.map((item) => item.assetId)
      .filter((id) => id === asset('c') || id === asset('b')),
  ).toEqual([asset('c'), asset('b')])
  void plain
})

it('正文与上游 Markdown 各带一个绑定时，两段标记互不串用身份', async () => {
  const { server, id, doc } = await boot()
  const first = createElement(doc, {
    id: 'first',
    kind: 'image',
    name: '甲',
    assetId: asset('a'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const second = createElement(doc, {
    id: 'second',
    kind: 'image',
    name: '乙',
    assetId: asset('b'),
    x: 0,
    y: 200,
    w: 100,
    h: 100,
  })
  const markdown = createElement(doc, {
    kind: 'markdown',
    id: 'md',
    text: '@乙',
    params: {
      [boundary('乙', second)]: {
        type: 'image',
        assetId: asset('b'),
        source: second,
        sourcePort: 'image',
      },
    },
    x: 0,
    y: 400,
    w: 200,
    h: 100,
  })
  const node = target(doc, '@甲', {
    [boundary('甲', first)]: {
      type: 'image',
      assetId: asset('a'),
      source: first,
      sourcePort: 'image',
    },
  })
  connect(doc, [markdown, 'text'], [node, 'prompt'])
  const submit = vi.spyOn(mockProvider, 'submit')
  const input = await server.runs.preview(id, node, 'local')
  expect(input.status).toBe('ready')
  expect(input.inputs.images?.map((item) => item.assetId)).toEqual([asset('a'), asset('b')])
  const posted = await submitted(server, id, node, submit)
  expect(
    posted.references
      ?.map((item) => item.assetId)
      .filter((id) => id === asset('a') || id === asset('b')),
  ).toEqual([asset('a'), asset('b')])
  expect(input.prompt).not.toContain('@甲')
  expect(input.prompt).not.toContain('@乙')
})

it('可选参考被模型上限正常舍弃时保留可读名，不误报失效、也不禁用生成', async () => {
  videoSpec.limits = { ...videoLimits, references: { max: 1 } }
  const { server, id, doc } = await boot()
  const plain = createElement(doc, {
    id: 'plain-limit',
    kind: 'image',
    name: '甲',
    assetId: asset('a'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const bound = createElement(doc, {
    id: 'bound-limit',
    kind: 'image',
    name: '乙',
    assetId: asset('b'),
    x: 0,
    y: 200,
    w: 100,
    h: 100,
  })
  const node = target(doc, '@甲 与 @乙', {
    [boundary('乙', bound)]: {
      type: 'image',
      assetId: asset('b'),
      source: bound,
      sourcePort: 'image',
    },
  })
  const submit = vi.spyOn(mockProvider, 'submit')
  const input = await server.runs.preview(id, node, 'local')
  expect(input.status).toBe('ready')
  expect(input.inputs.images?.map((item) => item.assetId)).toEqual([asset('a')])
  expect(
    input.notices.some(
      (notice) => notice.code === 'optional_dropped' && notice.message.includes('乙'),
    ),
  ).toBe(true)
  expect(input.blocked.some((issue) => issue.message.includes('已删除、替换或未送入'))).toBe(false)
  // 同一有效绑定只用 over_limit 解释一次，不再追加「请重新选择」。
  const limitRef = input.promptReferences?.find((ref) => ref.name === '乙')
  expect(limitRef?.reason).toBe('over_limit')
  expect(limitRef?.message ?? '').not.toContain('重新选择')
  const limitUnsent = (input.unsent ?? []).filter(
    (item) => item.elementId === bound && item.reason === 'over_limit',
  )
  expect(limitUnsent).toHaveLength(1)
  expect(limitUnsent[0]?.message ?? '').not.toContain('重新选择')
  expect(
    (input.unsent ?? []).some((item) => item.elementId === bound && item.reason === 'not_sent'),
  ).toBe(false)
  const posted = await submitted(server, id, node, submit)
  expect(posted.references?.some((item) => item.assetId === asset('a'))).toBe(true)
  expect(posted.references?.some((item) => item.assetId === asset('b'))).toBe(false)
  void plain
})

it('错口 token 不能代替同一来源的合法限额豁免', async () => {
  videoSpec.limits = { ...videoLimits, references: { max: 1 } }
  const { server, id, doc } = await boot()
  createElement(doc, {
    id: 'plain-mixed',
    kind: 'image',
    name: '甲',
    assetId: asset('a'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const bound = createElement(doc, {
    id: 'bound-mixed',
    kind: 'image',
    name: '乙',
    assetId: asset('b'),
    x: 0,
    y: 200,
    w: 100,
    h: 100,
  })
  const node = target(doc, '@甲 与 @乙 以及 @伪口', {
    [boundary('乙', bound)]: {
      type: 'image',
      assetId: asset('b'),
      source: bound,
      sourcePort: 'image',
    },
    [boundary('伪口', bound)]: {
      type: 'image',
      assetId: asset('b'),
      source: bound,
      sourcePort: 'lastFrame',
    },
  })
  const submit = vi.spyOn(mockProvider, 'submit')
  const input = await server.runs.preview(id, node, 'local')
  expect(input.status).not.toBe('ready')
  expect(input.blocked.some((issue) => issue.message.includes('伪口'))).toBe(true)
  expect(submit).not.toHaveBeenCalled()
})

it('必需参考正常超限仍按原合同阻断', async () => {
  videoSpec.limits = { ...videoLimits, references: { max: 1 } }
  const { server, id, doc } = await boot()
  const own = createElement(doc, {
    id: 'own',
    kind: 'image',
    name: '甲',
    assetId: asset('a'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const bound = createElement(doc, {
    id: 'required',
    kind: 'image',
    name: '乙',
    assetId: asset('b'),
    x: 0,
    y: 200,
    w: 100,
    h: 100,
  })
  const node = target(doc, '@甲 与 @乙', {
    requiredRefs: [bound],
    [boundary('乙', bound)]: {
      type: 'image',
      assetId: asset('b'),
      source: bound,
      sourcePort: 'image',
    },
  })
  connect(doc, [own, 'image'], [node, 'images'])
  const submit = vi.spyOn(mockProvider, 'submit')
  const input = await server.runs.preview(id, node, 'local')
  expect(input.status).not.toBe('ready')
  expect(
    input.blocked.some(
      (issue) => issue.message.includes('必需参考') && issue.message.includes('最多带'),
    ),
  ).toBe(true)
  expect(submit).not.toHaveBeenCalled()
})

it('视觉对话选中普通图后新增同名素材，实际输入仍只送原图', async () => {
  const { server, id, doc } = await boot()
  const original = createElement(doc, {
    id: 'zz',
    kind: 'image',
    name: '风',
    assetId: asset('z'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const chat = addNode(doc, 'plein/llm', {
    params: {
      model: 'plein/mock:agent-vision',
      prompt: '@风 看看',
      [boundary('风', original)]: {
        type: 'image',
        assetId: asset('z'),
        source: original,
        sourcePort: 'image',
      },
    },
    x: 600,
  })
  const before = await server.runs.preview(id, chat, 'local')
  expect(before.status).toBe('ready')
  expect(before.inputs.images).toMatchObject([{ assetId: asset('z'), source: original }])

  // 再上传/新建一张同名可引用图，不触碰正文与绑定。
  createElement(doc, {
    id: 'aa',
    kind: 'image',
    name: '风',
    assetId: asset('a'),
    x: 0,
    y: 300,
    w: 100,
    h: 100,
  })
  const input = await server.runs.preview(id, chat, 'local')
  expect(input.status).toBe('ready')
  expect(input.inputs.images).toMatchObject([{ assetId: asset('z'), source: original }])
  expect(input.inputs.images?.some((item) => item.assetId === asset('a'))).toBe(false)
  // 正文仍可读，不把私有标记或平台编号写进普通对话。
  expect(input.prompt).not.toMatch(/\uE000|\uE001|\uE004|\uE005/)
})

it('手输普通 @ 仍按名字送入唯一目标', async () => {
  const { server, id, doc } = await boot()
  const targetImage = createElement(doc, {
    id: 'solo',
    kind: 'image',
    name: '风',
    assetId: asset('s'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const chat = addNode(doc, 'plein/llm', {
    params: { model: 'plein/mock:agent-vision', prompt: '@风 看看' },
    x: 600,
  })
  const input = await server.runs.preview(id, chat, 'local')
  expect(input.status).toBe('ready')
  expect(input.inputs.images).toMatchObject([{ assetId: asset('s'), source: targetImage }])
})

it('非编号能力的错型绑定明确未送入，可读名与私有标记不泄漏', async () => {
  const { server, id, doc } = await boot()
  const media = createElement(doc, {
    id: 'wrong-type',
    kind: 'image',
    name: '风',
    assetId: asset('w'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const chat = addNode(doc, 'plein/llm', {
    params: {
      model: 'plein/mock:agent-vision',
      prompt: '@风 看看',
      system: '讲述 @风',
      [boundary('风', media)]: {
        type: 'video',
        assetId: asset('w'),
        source: media,
        sourcePort: 'video',
      },
    },
    x: 600,
  })
  const input = await server.runs.preview(id, chat, 'local')
  expect(input.inputs.images ?? []).toEqual([])
  expect(input.notices.some((notice) => notice.code === 'stale_binding')).toBe(true)
  expect(input.prompt).toBe('@风 看看')
  expect(input.params.system).toBe('讲述 @风')
  expect(input.prompt).not.toMatch(/\uE000|\uE001|\uE004|\uE005/)
})

it('已有绑定后把原图连入视觉 LLM：仍按连线送入一次，同名不阻断', async () => {
  const { server, id, doc } = await boot()
  const first = createElement(doc, {
    id: 'linked',
    kind: 'image',
    name: '风',
    assetId: asset('l'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  createElement(doc, {
    id: 'same-name',
    kind: 'image',
    name: '风',
    assetId: asset('s'),
    x: 0,
    y: 200,
    w: 100,
    h: 100,
  })
  const chat = addNode(doc, 'plein/llm', {
    params: {
      model: 'plein/mock:agent-vision',
      prompt: '@风 看看',
      [boundary('风', first)]: {
        type: 'image',
        assetId: asset('l'),
        source: first,
        sourcePort: 'image',
      },
    },
    x: 600,
  })
  connect(doc, [first, 'image'], [chat, 'images'])
  const input = await server.runs.preview(id, chat, 'local')
  expect(input.status).toBe('ready')
  expect(input.inputs.images).toMatchObject([{ assetId: asset('l'), source: first }])
  expect(input.inputs.images).toHaveLength(1)
  expect(input.inputs.images?.some((item) => item.assetId === asset('s'))).toBe(false)
  expect(input.blocked.some((issue) => issue.message.includes('2 个风'))).toBe(false)
})
