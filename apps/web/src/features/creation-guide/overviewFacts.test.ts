import {
  addResults,
  adoptResult,
  connect,
  createDoc,
  createElement,
  creativeReviewTarget,
  deleteElements,
  recordCreativeReview,
  selectProductionTarget,
  updateElement,
  writeRun,
  type DeliveryRecord,
  type PleinDoc,
} from '@plein/doc'
import { Shot } from '@plein/nodes'
import type { JobInfo } from '@plein/protocol'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { creationGuideFacts } from './facts'
import { productionOverviewFacts } from './overviewFacts'
import { goalScopeOf } from './productionGoalScope'

const docs: PleinDoc[] = []
afterEach(() => {
  for (const d of docs.splice(0)) d.destroy()
})
const seed = () => {
  const doc = createDoc(undefined, { schedule: () => {} })
  docs.push(doc)
  const node = (nodeType: string, params = {}) =>
    createElement(doc, { kind: 'node', nodeType, params, x: 0, y: 0, w: 100, h: 100 })
  const boardId = node('plein/storyboard', {
    shots: [Shot.parse({ id: 'shot', no: 1, description: '代表镜头', duration: 8 })],
  })
  const video = node('plein/video', {
    source: { storyboard: boardId, shot: 'shot', role: 'video' },
  })
  const image = node('plein/image', {
    source: { storyboard: boardId, shot: 'shot', role: 'image' },
  })
  let count = 0
  const result = (id: string, type: 'video' | 'image', adopt = true) => {
    const r = {
      id: `r-${++count}`,
      port: type,
      at: count,
      runId: `run-${count}`,
      value: { type, assetId: count.toString().padStart(64, 'a') },
    }
    addResults(doc, id, [r], { adopt })
    return r
  }
  const sequence = () => {
    const id = node('plein/sequence')
    updateElement(doc, video, {
      ports: { inputs: [], outputs: [{ id: 'video', label: '视频', type: 'video' }] },
    })
    updateElement(doc, id, {
      ports: {
        inputs: [{ id: 'clips', label: '镜头', type: 'video', multiple: true }],
        outputs: [],
      },
    })
    expect(connect(doc, [video, 'video'], [id, 'clips'])).toBeTruthy()
    return id
  }
  const facts = () => creationGuideFacts(doc, { boardId, canvasId: 'canvas' })
  return { doc, node, boardId, video, image, result, sequence, facts }
}

describe('制作总览事实', () => {
  it('候选产物、采用与人工可用分开；运行成功标记不能补齐产物', () => {
    const f = seed()
    f.result(f.video, 'video', false)
    f.result(f.image, 'image')
    writeRun(f.doc, f.video, { id: 'last', status: 'succeeded', at: 1 })
    let view = productionOverviewFacts(f.doc, f.facts())
    expect(view).toMatchObject({
      produced: 2,
      adopted: 1,
      usable: 0,
      total: 2,
      delivered: false,
      planDuration: 8,
    })
    expect(view.issues.some((i) => i.id === `candidate-${f.video}`)).toBe(true)
    recordCreativeReview(f.doc, f.image, {
      target: creativeReviewTarget(f.doc.get(f.image))!,
      status: 'usable',
    })
    view = productionOverviewFacts(f.doc, f.facts())
    expect(view.usable).toBe(1)
    const old = f.doc.get(f.image)!.results![0]!
    const candidate = f.result(f.image, 'image', false)
    expect(productionOverviewFacts(f.doc, f.facts()).usable).toBe(1)
    adoptResult(f.doc, f.image, candidate.id)
    expect(productionOverviewFacts(f.doc, f.facts()).usable).toBe(0)
    expect(f.doc.get(f.image)!.reviews![0]!.target.resultId).toBe(old.id)
  })

  it('多分镜与已删除范围不混入，读取不修改文档且只读可查看', () => {
    const f = seed()
    const other = f.node('plein/storyboard', { shots: [Shot.parse({ id: 'other', no: 1 })] })
    f.result(f.video, 'video')
    const before = JSON.stringify([...f.doc.elements()])
    expect(productionOverviewFacts(f.doc, creationGuideFacts(f.doc)).total).toBe(0)
    expect(
      productionOverviewFacts(f.doc, creationGuideFacts(f.doc, { boardId: other })).total,
    ).toBe(0)
    f.doc.readOnly = true
    expect(productionOverviewFacts(f.doc, f.facts()).produced).toBe(1)
    expect(JSON.stringify([...f.doc.elements()])).toBe(before)
    f.doc.readOnly = false
    deleteElements(f.doc, [f.boardId])
    expect(productionOverviewFacts(f.doc, f.facts()).total).toBe(0)
  })

  it('旧输入和已保留结果单列；人工结论仍指候选自身，不自动满足新目标', () => {
    const f = seed()
    f.result(f.video, 'video')
    f.result(f.image, 'image')
    recordCreativeReview(f.doc, f.video, {
      target: creativeReviewTarget(f.doc.get(f.video))!,
      status: 'usable',
    })
    const view = productionOverviewFacts(f.doc, f.facts(), {
      stale: new Map([
        [f.video, 'self'],
        [f.image, 'kept'],
      ]),
    })
    expect(view).toMatchObject({ stale: 2, usable: 1 })
    expect(view.issues.find((i) => i.id === `stale-${f.image}`)?.message).toContain('未核对新目标')
    expect(view.issues.find((i) => i.id === `stale-${f.video}`)?.message).toContain('旧输入')
  })

  it('恢复、未知提交、已存储待采用和失败按实际任务显示；其他分镜任务不混入', () => {
    const f = seed()
    const job = (
      id: string,
      recovery: JobInfo['recovery'],
      status: JobInfo['status'] = 'failed',
      nodeId = f.video,
    ): JobInfo => ({
      id,
      nodeId,
      nodeType: 'plein/video',
      status,
      attempts: 1,
      createdAt: 1,
      recovery,
    })
    const view = productionOverviewFacts(f.doc, f.facts(), {
      jobs: [
        job('unknown', { state: 'submit_unknown' }),
        job('fetch', { state: 'fetch_failed', refetchable: true }),
        job('held', { state: 'stored', held: 'candidate_only' }, 'succeeded'),
        job('fail', { state: 'remote_failed' }),
        job('unrelated', { state: 'submit_unknown' }, 'failed', 'another-board-video'),
      ],
    })
    const messages = view.issues
      .filter((i) => i.task)
      .map((i) => i.message)
      .join('\n')
    expect(messages).toContain('提交结果未知')
    expect(messages).toContain('结果没存到本地')
    expect(messages).toContain('待采用')
    expect(messages).toContain('失败')
    expect(view.issues.some((i) => i.id === 'job-unrelated')).toBe(false)
  })

  it('多序列要求明确范围；删除/同名替换不降级成分镜目标', () => {
    const f = seed()
    const a = f.sequence(),
      b = f.sequence()
    expect(goalScopeOf(f.facts(), 'canvas')).toBeUndefined()
    selectProductionTarget(f.doc, f.boardId, { sequenceId: b })
    expect(goalScopeOf(f.facts(), 'canvas')).toEqual({
      canvasId: 'canvas',
      boardId: f.boardId,
      sequenceId: b,
    })
    deleteElements(f.doc, [b])
    expect(f.facts().sequences.map((s) => s.id)).toEqual([a])
    expect(goalScopeOf(f.facts(), 'canvas')).toBeUndefined()
    f.sequence()
    expect(goalScopeOf(f.facts(), 'canvas')).toBeUndefined()
  })

  it('成片实际数据只取绑定当前候选的film记录，旧版确认不继承', () => {
    const f = seed()
    f.result(f.video, 'video')
    const sequence = f.sequence()
    const output = f.result(sequence, 'video')
    const delivery: DeliveryRecord = {
      id: 'delivery',
      resultId: output.id,
      runId: output.runId,
      assetId: output.value.assetId,
      kind: 'film',
      version: 'v1',
      createdAt: 1,
      width: 1080,
      height: 1920,
      duration: 8,
      sources: [],
      notes: [],
      confirmedAt: 2,
    }
    updateElement(f.doc, sequence, { deliveries: [delivery] })
    expect(productionOverviewFacts(f.doc, f.facts())).toMatchObject({ delivered: true, delivery })
    updateElement(f.doc, sequence, { deliveries: [{ ...delivery, historical: true }] })
    expect(productionOverviewFacts(f.doc, f.facts())).toMatchObject({
      delivered: false,
      delivery: undefined,
    })
    expect(f.doc.get(sequence)?.deliveries?.[0]?.confirmedAt).toBe(2)
    updateElement(f.doc, sequence, { deliveries: [delivery] })
    f.result(sequence, 'video')
    expect(productionOverviewFacts(f.doc, f.facts())).toMatchObject({
      delivered: false,
      delivery: undefined,
    })
  })
})
