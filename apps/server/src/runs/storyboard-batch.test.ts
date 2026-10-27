import { expandShots, expandedNodes, type ShotSource } from '@plein/capabilities'
import {
  addResults,
  connect,
  currentResult,
  removeEdges,
  setParams,
  updateElement,
} from '@plein/doc'
import type { Shot } from '@plein/nodes'
import { API, type StoryboardBatchPlan, type StoryboardBatchRequest } from '@plein/protocol'
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
import { batchSourceKey, planChange } from './batch'

afterEach(() => vi.restoreAllMocks())
const setup = async (extra: Partial<Shot> = {}) => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const shots: Shot[] = [1, 2].map((no) => ({
    id: `batch-shot-${no}`,
    no,
    duration: 5,
    shotSize: '中景',
    description: `画面 ${no}`,
    characters: [],
    emotion: '',
    lighting: '',
    sfx: '',
    dialogue: [],
    imagePrompt: `镜头 ${no}`,
    motionPrompt: '缓慢推进',
    ...extra,
  }))
  const board = addNode(doc, 'plein/storyboard', { params: { shots } })
  expandShots(
    doc,
    board,
    shots.map((s) => s.id),
    makeNode,
  )
  const node = (shot: number, role = 'image') =>
    expandedNodes(doc, board)
      .get(shots[shot]!.id)!
      .find((el) => (el.params?.source as ShotSource)?.role === role)!.id
  const body: StoryboardBatchRequest = {
    shotIds: shots.map((s) => s.id),
    role: 'image',
    reuseExisting: true,
  }
  const preview = async (input = body) => {
    const res = await request(server, API.storyboardBatchPreview(id, board), {
      method: 'POST',
      body: JSON.stringify(input),
    })
    expect(res.status).toBe(200)
    return (await res.json()) as StoryboardBatchPlan
  }
  const commit = (token: string) =>
    request(server, API.storyboardBatchCommit(id, board), {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
  const wait = async (groupId: string) => {
    await until(() => server.runs.groupState(groupId, 'local')?.status === 'done')
    return server.runs.groupState(groupId, 'local')!
  }
  return { server, id, doc, board, shots, node, body, preview, commit, wait }
}

describe('批量清单预检与确认', () => {
  it('本镜视频清单只提交指定一镜，返回202与total=1且不生成其他镜头', async () => {
    const f = await setup()
    for (const index of [0, 1]) {
      const video = f.node(index, 'video')
      setParams(f.doc, video, { mode: 'text' })
      removeEdges(
        f.doc,
        [...f.doc.edges()].filter((edge) => edge.to[0] === video).map((edge) => edge.id),
      )
    }
    const submit = vi.spyOn(mockProvider, 'submit')
    const target = f.node(0, 'video')
    const plan = await f.preview({
      shotIds: [f.shots[0]!.id],
      role: 'video',
      reuseExisting: true,
    })
    expect(plan.rows.map((row) => row.nodeId)).toEqual([target])
    expect(plan.summary).toMatchObject({ run: 1, blocked: 0, calls: 1 })
    expect(submit).not.toHaveBeenCalled()
    const response = await f.commit(plan.token)
    expect(response.status).toBe(202)
    const started = (await response.json()) as { groupId: string; total: number }
    expect(started.total).toBe(1)
    expect((await f.wait(started.groupId)).summary?.succeeded).toBe(1)
    expect(f.server.runs.store.batchItems(started.groupId).map((item) => item.node_id)).toEqual([
      target,
    ])
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]![0].capability).toBe('video.generate')
    expect(currentResult(f.doc.get(target)!)?.value.type).toBe('video')
    expect(f.doc.get(f.node(1, 'video'))?.results ?? []).toEqual([])
    expect(f.doc.get(f.node(0))?.results ?? []).toEqual([])
  })

  it('预检零提交，已采用沿用、未就绪阻塞、空台词跳过；确认仅运行已批准目标', async () => {
    const f = await setup()
    addResults(f.doc, f.node(0), [
      {
        id: 'existing',
        port: 'images',
        value: { type: 'image', assetId: 'a'.repeat(64) },
        runId: 'old',
        at: 1,
      },
    ])
    const submit = vi.spyOn(mockProvider, 'submit')
    const plan = await f.preview()
    expect(plan.summary).toMatchObject({ run: 1, reuse: 1, calls: 1, unknownCalls: 1 })
    expect(submit).not.toHaveBeenCalled()
    expect((await f.preview({ ...f.body, role: 'video' })).summary.blocked).toBeGreaterThan(0)
    const response = await f.commit(plan.token)
    expect(response.status).toBe(202)
    const started = (await response.json()) as { groupId: string; total: number }
    expect(started.total).toBe(1)
    expect((await f.wait(started.groupId)).summary?.succeeded).toBe(1)
    expect(currentResult(f.doc.get(f.node(0))!)?.id).toBe('existing')
    expect(submit).toHaveBeenCalledTimes(1)
    expect((await f.preview({ ...f.body, role: 'speech' })).summary.skip).toBe(2)
    expect((await f.commit(plan.token)).status).toBe(400)
  })

  it('实际输入改变返回409与新清单；布局变化不改变服务端批准内容', async () => {
    const f = await setup()
    const submit = vi.spyOn(mockProvider, 'submit')
    const plan = await f.preview()
    setParams(f.doc, f.node(0), { prompt: '用户手改后的构图' })
    const stale = await f.commit(plan.token)
    expect(stale.status).toBe(409)
    const refreshed = ((await stale.json()) as { plan: StoryboardBatchPlan }).plan
    expect(refreshed.rows.find((row) => row.nodeId === f.node(0))?.input?.prompt).toContain(
      '用户手改',
    )
    expect(submit).not.toHaveBeenCalled()
    updateElement(f.doc, f.node(0), { x: 808 })
    const started = await f.commit(refreshed.token)
    expect(started.status).toBe(202)
    await f.wait(((await started.json()) as { groupId: string }).groupId)
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('令牌并发确认只创建一个组；等待期间的上游内容变化触发重新审查', async () => {
    const f = await setup()
    const text = addNode(f.doc, 'plein/text', { params: { text: '原文' } })
    connect(f.doc, [text, 'text'], [f.node(0), 'prompt'])
    const plan = await f.preview()
    const responses = await Promise.all([f.commit(plan.token), f.commit(plan.token)])
    expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([202, 409])
    const started = (await responses.find((r) => r.status === 202)!.json()) as { groupId: string }
    const item = f.server.runs.store
      .batchItems(started.groupId)
      .find((i) => i.node_id === f.node(0))!
    const dependencies = JSON.parse(item.deps) as Array<{ nodeId: string; sourceKey?: string }>
    expect(dependencies.some((d) => d.nodeId === text && d.sourceKey)).toBe(true)
    await f.wait(started.groupId)
    const original = batchSourceKey(f.doc, f.doc.get(text)!)
    setParams(f.doc, text, { text: '排队后修改' })
    expect(
      planChange(
        { deps: [{ nodeId: text, sourceKey: original }] },
        { planHash: 'unused' },
        { doc: f.doc, store: f.server.runs.store },
      ),
    ).toContain('内容或连线')
  })

  it('原任务待核查不能冒作新生成，旧分镜变更需先同步，陌生镜头和外部画布拒绝', async () => {
    const f = await setup()
    const node = f.node(0)
    f.server.runs.store.insert({
      id: 'unknown-job',
      ownerId: 'local',
      canvasId: f.id,
      nodeId: node,
      nodeType: 'plein/image',
    })
    f.server.runs.store.update('unknown-job', {
      status: 'failed',
      error: '未知提交',
      recovery: JSON.stringify({ state: 'submit_unknown' }),
    })
    const plan = await f.preview()
    expect(plan.rows.find((row) => row.nodeId === node)?.reason).toContain('原任务')
    setParams(f.doc, f.board, {
      shots: f.shots.map((shot) => ({ ...shot, imagePrompt: '新计划' })),
    })
    expect((await f.preview()).rows.find((row) => row.nodeId === f.node(1))?.reason).toContain(
      '尚未同步',
    )
    const invalid = await request(f.server, API.storyboardBatchPreview(f.id, f.board), {
      method: 'POST',
      body: JSON.stringify({ ...f.body, shotIds: ['missing'] }),
    })
    expect(invalid.status).toBe(400)
    const forbidden = await request(f.server, API.storyboardBatchPreview('other-canvas', f.board), {
      method: 'POST',
      body: JSON.stringify(f.body),
    })
    expect(forbidden.status).toBe(404)
    expect((await f.commit('unknown-token')).status).toBe(400)
  })

  it('图片批次的隐式资产准备列入调用数，目标全部沿用时不偷偷生成参考资产', async () => {
    const f = await setup({ characters: ['小林'], imagePrompt: '@小林 在窗边' })
    const reference = addNode(f.doc, 'plein/image', { params: { prompt: '角色参考' } })
    const card = addNode(f.doc, 'plein/character', { name: '小林' })
    connect(f.doc, [reference, 'images'], [card, 'references'])
    const plan = await f.preview()
    expect(plan.rows.find((row) => row.nodeId === reference)).toMatchObject({
      prerequisite: true,
      action: 'run',
      calls: 1,
    })
    expect(plan.summary.calls).toBe(3)
    expect((await f.commit(plan.token)).status).toBe(202)
    const groups = f.server.runs.list(f.id).groups
    await f.wait(groups[0]!.id)
    const reused = await f.preview()
    expect(reused.summary).toMatchObject({ run: 0, calls: 0, reuse: 2 })
  })

  it('空音效及依赖环均明确列出；清单不改变输入和采用结果', async () => {
    const f = await setup()
    const before = currentResult(f.doc.get(f.node(0))!)
    const a = f.node(0),
      b = f.node(1)
    connect(f.doc, [a, 'images'], [b, 'references'])
    connect(f.doc, [b, 'images'], [a, 'references'])
    const plan = await f.preview()
    expect(plan.summary.blocked).toBe(2)
    expect(plan.rows.every((row) => row.reason.includes('循环'))).toBe(true)
    expect((await f.preview({ ...f.body, role: 'sfx' })).summary.skip).toBe(2)
    expect(currentResult(f.doc.get(a)!)).toBe(before)
  })
})
