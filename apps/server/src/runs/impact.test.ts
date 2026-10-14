import {
  expandedNodes,
  expandShots,
  nodeElementOf,
  syncExpanded,
  type ShotSource,
} from '@plein/capabilities'
import {
  connect,
  createElement,
  currentResult,
  type PleinDoc,
  removeEdges,
  setParams,
} from '@plein/doc'
import {
  corePlugin,
  SEQUENCE_TYPE,
  type SequenceClip,
  type Shot,
  STORYBOARD_TYPE,
} from '@plein/nodes'
import { describeNode, type NodeDefinition } from '@plein/plugin-sdk'
import type { GroupRunStarted, ImpactDecision, ImpactReport, StaleNodes } from '@plein/protocol'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vite-plus/test'
import type { Server } from '../app'
import { assets } from '../storage/schema'
import { addNode, bootServer, createCanvas, mockSettings, request } from '../testing'

const make = (type: string) => {
  const def = corePlugin.nodes.find((d) => d.type === type) as NodeDefinition | undefined
  return def && nodeElementOf(describeNode(def, 'plein/core'))
}

const shot = (no: number): Shot => ({
  id: `shot_${no}`,
  no,
  duration: 4,
  shotSize: '中景',
  description: `第 ${no} 镜`,
  characters: ['林夏'],
  emotion: '',
  lighting: '',
  sfx: '',
  dialogue: [{ character: '林夏', line: `第 ${no} 句台词` }],
  imagePrompt: `第 ${no} 镜画面`,
  motionPrompt: '缓慢推近',
})

const sourceOf = (doc: PleinDoc, id: string) => doc.get(id)?.params?.source as ShotSource

/** 六镜头项目：角色卡带参考图，分镜展开成图 → 视频 + 配音，接进序列，全部跑出结果 */
async function sixShots() {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id: canvas, doc } = await createCanvas(server)
  const hero = addNode(doc, 'plein/character', {
    name: '林夏',
    params: { description: '短发，白衬衫' },
  })
  const portrait = createElement(doc, {
    kind: 'image',
    assetId: 'a'.repeat(64),
    x: 0,
    y: -300,
    w: 10,
    h: 10,
  })
  connect(doc, [portrait, 'image'], [hero, 'references'])
  const seq = addNode(doc, SEQUENCE_TYPE, { name: '序列', x: 3000 })
  const board = addNode(doc, STORYBOARD_TYPE, {
    name: '分镜',
    params: { shots: [1, 2, 3, 4, 5, 6].map(shot) },
    x: -800,
  })
  const ids = [1, 2, 3, 4, 5, 6].map((n) => `shot_${n}`)
  expandShots(doc, board, ids, make)
  const byShot = (n: number, role: ShotSource['role']) =>
    expandedNodes(doc, board)
      .get(`shot_${n}`)!
      .find((el) => sourceOf(doc, el.id).role === role)!.id
  const all = (role: ShotSource['role']) => [1, 2, 3, 4, 5, 6].map((n) => byShot(n, role))
  for (const role of ['image', 'video', 'speech'] as const)
    for (const node of all(role)) {
      const run = server.runs.start(canvas, node, 'local')
      expect(await server.runs.wait(run)).toBe('succeeded')
    }
  return { server, canvas, doc, board, seq, hero, portrait, byShot, all }
}

const report = async (server: Server, canvas: string) => {
  const res = await request(server, `/api/canvases/${canvas}/impact`)
  expect(res.status).toBe(200)
  return (await res.json()) as ImpactReport
}

async function runImpact(server: Server, canvas: string, nodes: string[]) {
  const res = await request(server, `/api/canvases/${canvas}/impact/run`, {
    method: 'POST',
    body: JSON.stringify({ nodes }),
  })
  expect(res.status).toBe(202)
  const { groupId } = (await res.json()) as GroupRunStarted
  for (;;) {
    const g = server.runs.groupState(groupId, 'local')!
    if (g.status !== 'running') return g.summary!
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** 每个节点当前采用的结果 */
const adopted = (doc: PleinDoc, ids: string[]) =>
  Object.fromEntries(ids.map((id) => [id, currentResult(doc.get(id)!)?.id]))

describe('影响分析与局部返工', () => {
  it('六镜头改第三镜头：只跑勾选的分支，其余镜头的结果、配音和剪辑参数不变', async () => {
    const { server, canvas, doc, board, seq, byShot, all } = await sixShots()
    const others = [1, 2, 4, 5, 6].flatMap((n) => [
      byShot(n, 'image'),
      byShot(n, 'video'),
      byShot(n, 'speech'),
    ])
    const before = adopted(doc, [...others, byShot(3, 'video')])
    const clips = structuredClone(doc.get(seq)!.params!.clips) as SequenceClip[]
    expect(clips).toHaveLength(6)

    // 没改动时没有受影响的节点
    expect((await report(server, canvas)).nodes).toEqual([])

    // 分镜表里改第三镜头的台词和画面：还没同步时只提示看差异
    const shots = doc.get(board)!.params!.shots as Shot[]
    setParams(doc, board, {
      shots: shots.map((s) =>
        s.no === 3
          ? {
              ...s,
              imagePrompt: '第 3 镜画面：雨夜',
              dialogue: [{ character: '林夏', line: '改过的台词' }],
              edited: true,
            }
          : s,
      ),
    })
    let r = await report(server, canvas)
    expect(r.plan).toEqual([{ storyboard: board, shot: 'shot_3', no: 3, fields: 2 }])
    expect(r.nodes.map((n) => [n.nodeId, n.suggest])).toEqual([
      [byShot(3, 'image'), 'sync'],
      [byShot(3, 'video'), 'keep'],
      [byShot(3, 'speech'), 'sync'],
    ])

    // 按同步合同写进节点后：配音建议重做，镜头图提示词变了也建议重做，视频是间接的、建议保留
    syncExpanded(doc, board, ['shot_3'], 'unmodified')
    r = await report(server, canvas)
    expect(r.plan).toEqual([])
    const view = r.nodes.map((n) => ({
      id: n.nodeId,
      shot: n.shot?.id,
      impact: n.impact,
      suggest: n.suggest,
      causes: n.causes.map((c) => c.kind),
    }))
    expect(view).toEqual([
      {
        id: byShot(3, 'image'),
        shot: 'shot_3',
        impact: 'direct',
        suggest: 'rerun',
        causes: ['prompt'],
      },
      {
        id: byShot(3, 'video'),
        shot: 'shot_3',
        impact: 'indirect',
        suggest: 'keep',
        causes: ['input'],
      },
      {
        id: byShot(3, 'speech'),
        shot: 'shot_3',
        impact: 'direct',
        suggest: 'rerun',
        causes: ['prompt'],
      },
    ])
    expect(r.nodes.find((n) => n.nodeId === byShot(3, 'speech'))!.causes[0]!.label).toBe('台词改了')
    // mock 模型没配价格：待执行两个，费用未知
    expect(r.summary).toMatchObject({ direct: 2, indirect: 1, cached: 0, pending: 2, kept: 0 })
    expect(r.summary.cost).toEqual({ amount: 0, unknown: 2 })

    // 只勾选配音和镜头图：视频不跑
    const summary = await runImpact(server, canvas, [byShot(3, 'speech'), byShot(3, 'image')])
    expect(summary).toMatchObject({ succeeded: 2, cached: 0, failed: 0 })
    expect(adopted(doc, [...others, byShot(3, 'video')])).toEqual(before)
    expect(doc.get(seq)!.params!.clips).toEqual(clips)
    expect(doc.get(byShot(3, 'image'))!.results).toHaveLength(2)
    // 新配音的字幕跟着新台词
    const speech = currentResult(doc.get(byShot(3, 'speech'))!)!.value
    expect(speech).toMatchObject({ type: 'audio', caption: '改过的台词' })

    // 视频现在直接过期（首帧换了）：用户选择保留，决定持久、可查，但不改缓存
    r = await report(server, canvas)
    const video = r.nodes.find((n) => n.nodeId === byShot(3, 'video'))!
    expect(video).toMatchObject({ impact: 'direct', suggest: 'rerun' })
    expect(
      (
        await request(server, `/api/canvases/${canvas}/impact/keep`, {
          method: 'POST',
          body: JSON.stringify({ nodes: [{ nodeId: video.nodeId, inputHash: 'stale' }] }),
        })
      ).status,
    ).toBe(409)
    const kept = await request(server, `/api/canvases/${canvas}/impact/keep`, {
      method: 'POST',
      body: JSON.stringify({
        nodes: [{ nodeId: video.nodeId, inputHash: video.inputHash }],
        note: '先用旧视频',
      }),
    })
    expect(kept.status).toBe(201)
    const [decision] = (await kept.json()) as ImpactDecision[]
    expect(decision).toMatchObject({ nodeId: video.nodeId, note: '先用旧视频' })
    expect(decision!.causes.map((c) => c.kind)).toEqual(['input'])
    r = await report(server, canvas)
    expect(r.nodes.find((n) => n.nodeId === video.nodeId)!.kept?.id).toBe(decision!.id)
    expect(r.summary.kept).toBe(1)
    expect(r.decisions[0]!.id).toBe(decision!.id)
    const stale = (await (
      await request(server, `/api/canvases/${canvas}/stale`)
    ).json()) as StaleNodes
    expect(stale.stale).toContain(video.nodeId)
    expect(stale.kept).toEqual([video.nodeId])

    // 撤销画面修改：新候选还在，重做时直接改用按原输入生成的旧候选，不调用平台
    const img = byShot(3, 'image')
    const oldImage = doc.get(img)!.results!.at(-1)!.id
    setParams(doc, img, { prompt: String(doc.get(img)!.params!.prompt).replace('：雨夜', '') })
    r = await report(server, canvas)
    expect(r.nodes.find((n) => n.nodeId === img)!.cached).toEqual({ resultId: oldImage })
    expect(r.summary.cached).toBe(1)
    expect(await runImpact(server, canvas, [img])).toMatchObject({ succeeded: 0, cached: 1 })
    expect(currentResult(doc.get(img)!)!.id).toBe(oldImage)
    expect(doc.get(img)!.results).toHaveLength(2)

    // 撤销保留：记录留着，标为已撤销
    const del = () =>
      request(server, `/api/canvases/${canvas}/impact/keep/${decision!.id}`, { method: 'DELETE' })
    expect((await del()).status).toBe(204)
    expect((await del()).status).toBe(404)
    r = await report(server, canvas)
    expect(r.decisions[0]!.revokedAt).toBeGreaterThan(0)
    expect(all('video')).toHaveLength(6)
  }, 30_000)

  it('角色参考图换了：引用它的镜头图建议审查，原视频保留；换视频候选后检查序列入出点', async () => {
    const { server, canvas, doc, seq, portrait, byShot } = await sixShots()
    // 换一张参考图
    const next = createElement(doc, {
      kind: 'image',
      assetId: 'b'.repeat(64),
      x: 0,
      y: -600,
      w: 10,
      h: 10,
    })
    const hero = [...doc.edges()].find((e) => e.from[0] === portrait)!.to[0]
    removeEdges(
      doc,
      [...doc.edges()].filter((e) => e.from[0] === portrait).map((e) => e.id),
    )
    connect(doc, [next, 'image'], [hero, 'references'])
    const r = await report(server, canvas)
    const images = r.nodes.filter((n) => n.shot?.role === 'image')
    expect(images).toHaveLength(6)
    for (const n of images) {
      expect(n).toMatchObject({ impact: 'direct', suggest: 'review' })
      expect(n.causes).toEqual([{ kind: 'reference', key: hero, label: '「林夏」的参考图换了' }])
    }
    const videos = r.nodes.filter((n) => n.shot?.role === 'video')
    expect(videos.every((n) => n.impact === 'indirect' && n.suggest === 'keep')).toBe(true)
    expect(r.nodes.some((n) => n.shot?.role === 'speech')).toBe(false)
    expect(r.summary.pending).toBe(0)

    // 第三镜头的视频再生成一个候选并采用：序列的来源跟着换，原入出点保留，越界给出提示
    const video = byShot(3, 'video')
    const run = server.runs.start(canvas, video, 'local')
    expect(await server.runs.wait(run)).toBe('succeeded')
    const clips = (doc.get(seq)!.params!.clips as SequenceClip[]).map((c) =>
      c.source === video ? { ...c, in: 0.5, out: 50 } : c,
    )
    setParams(doc, seq, { clips })
    const asset = (currentResult(doc.get(video)!)!.value as { assetId: string }).assetId
    server.db.update(assets).set({ duration: 4 }).where(eq(assets.id, asset)).run()
    const issues = (await report(server, canvas)).sequence.filter((i) => i.source === video)
    expect(issues).toContainEqual({
      sequenceId: seq,
      source: video,
      shotId: 'shot_3',
      kind: 'out_of_range',
      message: '出点 50 秒超出素材时长 4 秒，只播到素材结尾',
    })
    expect(
      (doc.get(seq)!.params!.clips as SequenceClip[]).find((c) => c.source === video),
    ).toMatchObject({
      in: 0.5,
      out: 50,
    })
  }, 30_000)
})
