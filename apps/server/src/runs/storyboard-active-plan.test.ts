import {
  activeShotNodes,
  expandedNodes,
  expandShots,
  runExpanded,
  type ShotSource,
} from '@plein/capabilities'
import { connect, setParams } from '@plein/doc'
import { Shot } from '@plein/nodes'
import type { ProviderRequest } from '@plein/plugin-sdk'
import { API, type StoryboardBatchPlan } from '@plein/protocol'
import { mockProvider } from '@plein/providers'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import {
  addNode,
  bootServer,
  createCanvas,
  makeNode,
  mockSettings,
  request,
  until,
} from '../testing'

afterEach(() => vi.restoreAllMocks())
const fixture = async (input: Partial<Shot> = {}) => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const shot = Shot.parse({
    id: 'active-shot',
    no: 1,
    description: '画面',
    imagePrompt: '画面',
    motionPrompt: '推进',
    ...input,
  })
  const board = addNode(doc, 'plein/storyboard', { params: { shots: [shot] } })
  expandShots(doc, board, [shot.id], makeNode)
  const nodes = () => expandedNodes(doc, board).get(shot.id)!
  const preview = async (role: 'image' | 'speech' | 'sfx') => {
    const response = await request(server, API.storyboardBatchPreview(id, board), {
      method: 'POST',
      body: JSON.stringify({ shotIds: [shot.id], role, reuseExisting: false }),
    })
    expect(response.status).toBe(200)
    return (await response.json()) as StoryboardBatchPlan
  }
  const commit = (token: string) =>
    request(server, API.storyboardBatchCommit(id, board), {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
  return { server, id, doc, board, shot, nodes, preview, commit }
}

describe('批准清单只包含当前镜头计划', () => {
  it('每份必需参考都有可运行准备来源时，保留延迟复核并精确生成清单内三个项目', async () => {
    const f = await fixture({ characters: ['小林', '钥匙'], imagePrompt: '@小林 @钥匙 在窗边' })
    const cards = ['小林', '钥匙'].map((name) => {
      const reference = addNode(f.doc, 'plein/image', { params: { prompt: `${name}参考准备` } })
      const card = addNode(f.doc, name === '小林' ? 'plein/character' : 'plein/prop', { name })
      connect(f.doc, [reference, 'images'], [card, 'references'])
      return card
    })
    const image = f.nodes().find((node) => (node.params?.source as ShotSource)?.role === 'image')!
    setParams(f.doc, image.id, { requiredRefs: cards })
    const submit = vi.spyOn(mockProvider, 'submit')
    const plan = await f.preview('image')
    expect(plan.summary).toMatchObject({ run: 3, calls: 3, blocked: 0 })
    const response = await f.commit(plan.token)
    expect(response.status).toBe(202)
    const group = (await response.json()) as { groupId: string }
    await until(() => f.server.runs.groupState(group.groupId, 'local')?.status === 'done')
    expect(f.server.runs.groupState(group.groupId, 'local')?.summary?.succeeded).toBe(3)
    expect(submit).toHaveBeenCalledTimes(3)
  })
  it('必需参考没有任何可运行准备来源时应阻塞目标，不能因另一张参考可准备就先付费', async () => {
    const f = await fixture({ characters: ['小林', '钥匙'], imagePrompt: '@小林 @钥匙 在窗边' })
    const reference = addNode(f.doc, 'plein/image', { params: { prompt: '角色参考准备' } })
    const actor = addNode(f.doc, 'plein/character', { name: '小林' })
    const missing = addNode(f.doc, 'plein/prop', { name: '钥匙' })
    connect(f.doc, [reference, 'images'], [actor, 'references'])
    const image = f.nodes().find((node) => (node.params?.source as ShotSource)?.role === 'image')!
    setParams(f.doc, image.id, { requiredRefs: [actor, missing] })
    const submit = vi.spyOn(mockProvider, 'submit')
    const plan = await f.preview('image')
    expect(plan.rows.find((row) => row.nodeId === image.id)?.action).toBe('blocked')
    expect(plan.summary).toMatchObject({ run: 0, calls: 0 })
    expect(submit).not.toHaveBeenCalled()
  })
  it('删台词、清空音效只保留历史；新清单和旧批量都不能为已删内容调用平台', async () => {
    const f = await fixture({
      sfx: '门响',
      dialogue: [
        { id: 'keep-line', character: '', line: '保留的台词' },
        { id: 'deleted-line', character: '', line: '已经删除的台词' },
      ],
    })
    const oldSpeech = f
      .nodes()
      .find((node) => (node.params?.source as ShotSource)?.dialogueId === 'deleted-line')!
    const kept = f
      .nodes()
      .find((node) => (node.params?.source as ShotSource)?.dialogueId === 'keep-line')!
    const edited = { ...f.shot, sfx: '', dialogue: f.shot.dialogue.slice(0, 1) }
    setParams(f.doc, f.board, { shots: [edited] })
    expect(activeShotNodes(edited, f.nodes()).map((node) => node.id)).not.toContain(oldSpeech.id)
    const oldRun = vi.fn()
    runExpanded(f.doc, f.board, [f.shot.id], 'speech', oldRun)
    expect(oldRun.mock.calls).toEqual([[kept.id]])
    oldRun.mockClear()
    runExpanded(f.doc, f.board, [f.shot.id], 'sfx', oldRun)
    expect(oldRun).not.toHaveBeenCalled()
    const posted: ProviderRequest[] = []
    const submit = mockProvider.submit
    vi.spyOn(mockProvider, 'submit').mockImplementation(async (req, ctx) => {
      posted.push(req)
      return submit(req, ctx)
    })
    const plan = await f.preview('speech')
    expect(plan.summary).toMatchObject({ run: 1, calls: 1 })
    expect(plan.rows.map((row) => row.nodeId)).toEqual([kept.id])
    const response = await f.commit(plan.token)
    expect(response.status).toBe(202)
    const group = (await response.json()) as { groupId: string }
    await until(() => f.server.runs.groupState(group.groupId, 'local')?.status === 'done')
    expect(posted).toHaveLength(1)
    expect(posted[0]?.input).toMatchObject({ text: '保留的台词' })
    expect(f.doc.get(oldSpeech.id)?.params?.text).toBe('已经删除的台词')
    expect((await f.preview('sfx')).summary).toMatchObject({ skip: 1, calls: 0 })
    setParams(f.doc, f.board, { shots: [{ ...edited, dialogue: [] }] })
    const empty = await f.preview('speech')
    expect(empty.summary).toMatchObject({ skip: 1, run: 0, calls: 0 })
    expect((await f.commit(empty.token)).status).toBe(400)
    expect(posted).toHaveLength(1)
  })

  it('已批准的延迟输入排队期间修改角色设定，资产准备完成后需重新审查，不能偷偷提交镜头', async () => {
    const f = await fixture({ characters: ['小林'], imagePrompt: '@小林 在窗边' })
    const reference = addNode(f.doc, 'plein/image', { params: { prompt: '角色定妆图' } })
    const card = addNode(f.doc, 'plein/character', {
      name: '小林',
      params: { description: '黑色外套' },
    })
    connect(f.doc, [reference, 'images'], [card, 'references'])
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const posted: ProviderRequest[] = []
    const submit = mockProvider.submit
    vi.spyOn(mockProvider, 'submit').mockImplementation(async (req, ctx) => {
      posted.push(req)
      if ((req.input as { prompt?: string }).prompt?.startsWith('占用槽')) await gate
      return submit(req, ctx)
    })
    const blockers = Array.from({ length: 4 }, (_, i) =>
      addNode(f.doc, 'plein/image', { params: { prompt: `占用槽${i}` } }),
    )
    const blockerRuns = blockers.map((node) => f.server.runs.start(f.id, node, 'local'))
    await until(() => posted.length > 0)
    try {
      const plan = await f.preview('image')
      expect(plan.rows.find((row) => !row.prerequisite)?.deferred).toBe(true)
      const response = await f.commit(plan.token)
      expect(response.status).toBe(202)
      const group = (await response.json()) as { groupId: string }
      setParams(f.doc, card, { description: '临时改成白色外套' })
      release()
      await Promise.all(blockerRuns.map((id) => f.server.runs.wait(id)))
      await until(() => f.server.runs.groupState(group.groupId, 'local')?.status === 'done')
      const image = f.nodes().find((node) => (node.params?.source as ShotSource)?.role === 'image')!
      expect(f.server.runs.store.batchItem(group.groupId, image.id)?.outcome).toBe('review')
      expect(
        posted.some((req) => (req.input as { prompt?: string }).prompt?.includes('在窗边')),
      ).toBe(false)
    } finally {
      release()
    }
  })
})
