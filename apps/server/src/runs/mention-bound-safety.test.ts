import { connect, createElement, setText } from '@plein/doc'
import { mockProvider } from '@plein/providers'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import type { Server } from '../app'
import { addNode, bootServer, createCanvas, mockSettings, until } from '../testing'

afterEach(() => vi.restoreAllMocks())

const done = (server: Server, groupId: string) =>
  until(() => {
    const group = server.runs.groupState(groupId, 'local')
    return group?.status !== 'running' && group
  })

/** 一张带定妆图生成器的角色卡：批次若把它排进来就会多跑一次图片生成。 */
function character(doc: Parameters<typeof addNode>[0], params: Record<string, unknown> = {}) {
  const gen = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: '定妆' },
    x: -300,
  })
  const card = addNode(doc, 'plein/character', { name: '蓝', params, x: 0 })
  connect(doc, [gen, 'images'], [card, 'references'])
  return { gen, card }
}

it('已持久绑定的 @ 不再为同名卡添加隐式依赖，批次不提交那张卡的定妆图', async () => {
  const { server } = await bootServer()
  mockSettings(server, { latencyMs: 0 })
  const { id, doc } = await createCanvas(server)
  const { gen, card } = character(doc)
  // 绑定指向已不存在的来源：实际准备会把它当残留绑定忽略，不会消费同名卡。
  const consumer = addNode(doc, 'plein/video', {
    params: {
      model: 'minimax/api:MiniMax-H3',
      mode: 'reference',
      prompt: '@蓝 舞蹈',
      [`referenceNameBinding:${encodeURIComponent('蓝')}:gone`]: {
        type: 'image',
        assetId: '',
        source: 'gone',
      },
    },
    x: 600,
  })
  const submit = vi.spyOn(mockProvider, 'submit')
  const group = server.runs.runBatch(id, consumer, [consumer], 'local')
  await done(server, group.groupId)
  const items = server.runs.batchItems(group.groupId, 'local') ?? []
  expect(items.map((item) => item.nodeId)).toEqual([consumer])
  expect(items.map((item) => item.nodeId)).not.toContain(gen)
  const imageCalls = submit.mock.calls.filter(
    ([request]) => request.capability === 'image.generate',
  )
  expect(imageCalls).toHaveLength(0)
  expect(doc.get(gen)?.run).toBeUndefined()
  expect(doc.get(card)?.results ?? []).toHaveLength(0)
})

it('有效的 Markdown @ 角色仍先跑定妆图，再跑消费节点', async () => {
  const { server } = await bootServer()
  mockSettings(server, { latencyMs: 0 })
  const { id, doc } = await createCanvas(server)
  const { gen } = character(doc)
  const markdown = createElement(doc, {
    kind: 'markdown',
    id: 'md',
    x: 0,
    y: 300,
    w: 200,
    h: 100,
  })
  setText(doc, markdown, '@蓝 舞蹈')
  const consumer = addNode(doc, 'plein/video', {
    params: { model: 'minimax/api:MiniMax-H3', mode: 'reference', prompt: '' },
    x: 600,
  })
  connect(doc, [markdown, 'text'], [consumer, 'prompt'])
  const submit = vi.spyOn(mockProvider, 'submit')
  const group = server.runs.runBatch(id, consumer, [consumer], 'local')
  await done(server, group.groupId)
  const items = server.runs.batchItems(group.groupId, 'local') ?? []
  const ids = items.map((item) => item.nodeId)
  expect(ids).toContain(gen)
  expect(ids).toContain(consumer)
  expect(ids.indexOf(gen)).toBeLessThan(ids.indexOf(consumer))
  const imageCalls = submit.mock.calls.filter(
    ([request]) => request.capability === 'image.generate',
  )
  expect(imageCalls).toHaveLength(1)
  expect(doc.get(gen)?.results?.length ?? 0).toBeGreaterThan(0)
})
