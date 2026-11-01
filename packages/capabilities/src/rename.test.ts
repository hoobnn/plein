import { createElement, setParam, setText } from '@plein/doc'
import { openDoc, node } from '@plein/doc/testing'
import { findMentions } from '@plein/nodes'
import { referenceBindings, resolveReferenceBindings } from '@plein/plugin-sdk'
import { afterEach, expect, it } from 'vite-plus/test'
import { renameElement } from './rename'
import { mentionTargetsIn } from './story/nodes'

const docs: ReturnType<typeof openDoc>[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))
function fixture() {
  const doc = openDoc()
  docs.push(doc)
  return doc
}

it('改名与提示词、Markdown 引用一次撤销，普通文字、文件身份和历史结果不变', () => {
  const doc = fixture()
  const image = createElement(doc, {
    kind: 'image',
    id: 'image',
    name: '参考图.png',
    assetId: 'original',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const target = createElement(
    doc,
    node({
      params: {
        prompt: '@参考图.png 在窗边，参考图.png 是文件名，\\@参考图.png test@参考图.png',
        negativePrompt: '不要改变 @参考图.png',
        url: 'https://example.com/@参考图.png',
        source: '@参考图.png',
      },
      results: [
        {
          id: 'r',
          runId: 'run',
          at: 1,
          port: 'text',
          value: { type: 'text', text: '@参考图.png 原结果' },
        },
      ],
    }),
  )
  const text = createElement(doc, {
    kind: 'markdown',
    text: '请参考 @参考图.png。',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const ytext = doc.getText(text)
  const result = renameElement(doc, image, ' 新参考.png ')
  expect(result.references).toBe(3)
  expect(doc.get(image)).toMatchObject({ name: '新参考.png', assetId: 'original' })
  expect(doc.get(target)?.params).toMatchObject({
    prompt: '@新参考.png 在窗边，参考图.png 是文件名，\\@参考图.png test@参考图.png',
    negativePrompt: '不要改变 @新参考.png',
    url: 'https://example.com/@参考图.png',
    source: '@参考图.png',
  })
  expect(doc.get(target)?.results?.[0]?.value).toEqual({ type: 'text', text: '@参考图.png 原结果' })
  expect(doc.getText(text)).toBe(ytext)
  expect(ytext?.toString()).toBe('请参考 @新参考.png。')
  doc.undo.undo()
  expect(doc.get(image)?.name).toBe('参考图.png')
  expect(doc.get(target)?.params?.negativePrompt).toBe('不要改变 @参考图.png')
  expect(ytext?.toString()).toBe('请参考 @参考图.png。')
  doc.undo.redo()
  expect(doc.get(image)?.name).toBe('新参考.png')
  expect(ytext?.toString()).toBe('请参考 @新参考.png。')
})

it('同名卡片改名后重排两组序号，保留档案后缀，并阻止歧义引用意外恢复', () => {
  const doc = fixture()
  for (const [id, name] of [
    ['a', '林夏'],
    ['b', '林夏'],
    ['z', '小夏'],
  ])
    createElement(doc, node({ id, name, nodeType: 'plein/character' }))
  const prompt = createElement(
    doc,
    node({ params: { prompt: '@林夏#002/少年/校服 @林夏#1 @小夏 @林夏 @小夏#2' } }),
  )
  renameElement(doc, 'b', '小夏')
  const text = doc.get(prompt)?.params?.prompt as string
  expect(text).toBe('@小夏#1/少年/校服 @林夏 @小夏#2 @林夏#0 @小夏#0')
  expect(findMentions(text, mentionTargetsIn(doc)).map((m) => m.id)).toEqual([
    'b',
    'a',
    'z',
    undefined,
    undefined,
  ])
})

it.each(['image', 'video', 'audio'] as const)(
  '同步 %s 素材名称绑定，旧编号身份与引用目标保持不变',
  (kind) => {
    const doc = fixture()
    const source = createElement(doc, {
      id: 'media',
      kind,
      name: '旧 素材.mp4',
      assetId: 'file',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    const identity = { type: kind, assetId: 'file', source }
    const key = `referenceNameBinding:${encodeURIComponent('旧 素材.mp4')}:${source}`
    const target = createElement(
      doc,
      node({
        params: {
          prompt: `@旧 素材.mp4 与 @${kind}1`,
          [key]: identity,
          referenceBindings: { [`${kind}1`]: identity },
        },
      }),
    )
    renameElement(doc, source, '新素材')
    const params = doc.get(target)!.params!
    expect(params.prompt).toBe(`@新素材 与 @${kind}1`)
    expect(params[key]).toBeUndefined()
    expect(referenceBindings(params)).toMatchObject({ 新素材: identity, [`${kind}1`]: identity })
    expect(resolveReferenceBindings(params.prompt as string, [identity], params)).toEqual({
      prompt: `@${kind}1 与 @${kind}1`,
    })
  },
)

it('名称绑定与全画布同名节点一起消歧，并兼容旧的具名绑定', () => {
  const doc = fixture()
  for (const [id, name] of [
    ['a', '片段'],
    ['z', '另一段'],
  ])
    createElement(doc, { id, kind: 'video', name, assetId: id, x: 0, y: 0, w: 100, h: 100 })
  const a = { type: 'video', assetId: 'a', source: 'a' }
  const z = { type: 'video', assetId: 'z', source: 'z' }
  const target = createElement(
    doc,
    node({ params: { prompt: '@片段 @另一段', referenceBindings: { 片段: a, 另一段: z } } }),
  )
  renameElement(doc, 'a', '另一段')
  const params = doc.get(target)!.params!
  expect(params.prompt).toBe('@另一段#1 @另一段#2')
  expect(referenceBindings(params)).toEqual({ '另一段#1': a, '另一段#2': z })
})

it('分镜出场资产、角色台词身份和提示词同步，台词普通文字保留', () => {
  const doc = fixture()
  const role = createElement(doc, node({ nodeType: 'plein/character', name: '林夏' }))
  const board = createElement(
    doc,
    node({
      nodeType: 'plein/storyboard',
      params: {
        shots: [
          {
            id: 'shot',
            characters: ['林夏'],
            assetBindings: { 林夏: { elementId: role } },
            imagePrompt: '@林夏 微笑',
            motionPrompt: '@林夏 转身',
            dialogue: [
              { id: 'line', character: '林夏', speaker: { elementId: role }, line: '林夏，你好' },
            ],
          },
        ],
      },
    }),
  )
  renameElement(doc, role, '小夏')
  expect(doc.get(board)?.params?.shots).toEqual([
    {
      id: 'shot',
      characters: ['小夏'],
      assetBindings: { 小夏: { elementId: role } },
      imagePrompt: '@小夏 微笑',
      motionPrompt: '@小夏 转身',
      dialogue: [
        { id: 'line', character: '小夏', speaker: { elementId: role }, line: '林夏，你好' },
      ],
    },
  ])
})

it('分镜绑定冲突、非法名称、只读及删除均不能造成部分改名', () => {
  const doc = fixture()
  const a = createElement(doc, node({ name: '林夏', nodeType: 'plein/character' }))
  const b = createElement(doc, node({ name: '小夏', nodeType: 'plein/character' }))
  const prompt = createElement(doc, node({ params: { prompt: '@林夏' } }))
  const board = createElement(
    doc,
    node({
      nodeType: 'plein/storyboard',
      params: {
        shots: [
          {
            characters: ['林夏', '小夏'],
            assetBindings: { 林夏: { elementId: a }, 小夏: { elementId: b } },
          },
        ],
      },
    }),
  )
  expect(() => renameElement(doc, a, '小夏')).toThrow('分镜中已有')
  expect(doc.get(a)?.name).toBe('林夏')
  expect(doc.get(prompt)?.params?.prompt).toBe('@林夏')
  for (const name of ['', 'a\nb', '@林夏', 'a'.repeat(201)])
    expect(() => renameElement(doc, a, name)).toThrow()
  doc.readOnly = true
  expect(() => renameElement(doc, a, '新的名字')).toThrow()
  doc.readOnly = false
  expect(() => renameElement(doc, 'deleted', '新名字')).toThrow('节点已删除')
  expect(doc.get(board)?.params?.shots).toHaveLength(1)
})

it('未列入出场列表的显式资产绑定也随名称同步', () => {
  const doc = fixture()
  const role = createElement(doc, node({ nodeType: 'plein/character', name: '林夏' }))
  const board = createElement(
    doc,
    node({
      nodeType: 'plein/storyboard',
      params: {
        shots: [
          {
            id: 's',
            characters: [],
            assetBindings: { 林夏: { elementId: role, libraryId: 'library' } },
          },
        ],
      },
    }),
  )
  renameElement(doc, role, '小夏')
  expect(doc.get(board)?.params?.shots).toMatchObject([
    { assetBindings: { 小夏: { elementId: role, libraryId: 'library' } } },
  ])
  expect(
    (doc.get(board)?.params?.shots as Array<{ assetBindings: object }> | undefined)?.[0]
      ?.assetBindings,
  ).not.toHaveProperty('林夏')
})

it('文本、生成节点、分组均可改名；固定字幕、来源记录和历史设置不参与同步', () => {
  const doc = fixture()
  const role = createElement(doc, node({ nodeType: 'plein/character', name: '林夏' }))
  const target = createElement(
    doc,
    node({
      name: '生成图片',
      params: {
        text: '@林夏',
        legacySourceSettings: { prompt: '@林夏' },
        subtitleTrack: { cues: [{ text: '@林夏' }] },
      },
    }),
  )
  const frame = createElement(doc, { kind: 'frame', name: '分组', x: 0, y: 0, w: 100, h: 100 })
  const text = createElement(doc, {
    kind: 'markdown',
    name: '说明',
    text: '@林夏',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const sequence = createElement(
    doc,
    node({ nodeType: 'plein/sequence', params: { text: '@林夏' } }),
  )
  setText(doc, text, '@林夏')
  setParam(doc, target, 'origin', { prompt: '@林夏' })
  renameElement(doc, role, '小夏')
  expect(doc.get(target)?.params).toEqual({
    text: '@小夏',
    legacySourceSettings: { prompt: '@林夏' },
    subtitleTrack: { cues: [{ text: '@林夏' }] },
    origin: { prompt: '@林夏' },
  })
  expect(doc.get(sequence)?.params?.text).toBe('@林夏')
  for (const id of [target, frame, text]) {
    renameElement(doc, id, `新${id}`)
    expect(doc.get(id)?.name).toBe(`新${id}`)
  }
})
