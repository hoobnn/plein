import {
  addResults,
  appendProductionGoal,
  createDoc,
  createElement,
  currentResult,
  deleteElements,
  emptyProductionGoal,
  setParam,
  updateElement,
} from '@plein/doc'
import { referenceClipboard } from '@plein/capabilities'
import {
  Shot,
  DELIVERY_CHECK_RULES,
  DELIVERY_CHECK_TYPE,
  type DeliveryCheckReport,
} from '@plein/nodes'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import * as Y from 'yjs'
import {
  createDeliveryCheck,
  deliveryCheckRequest,
  deliveryReports,
  isCurrentDeliveryReport,
} from './model'

const docs: ReturnType<typeof createDoc>[] = []
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy()
})
function fixture() {
  const doc = createDoc(undefined, { schedule: () => {} })
  docs.push(doc)
  const node = (nodeType: string, params = {}) =>
    createElement(doc, { kind: 'node', nodeType, params, x: 0, y: 0, w: 100, h: 100 })
  const board = node('plein/storyboard', {
      shots: [Shot.parse({ id: 'shot', no: 1, description: '交接' })],
    }),
    sequence = node('plein/sequence')
  const output = {
    id: 'output',
    port: 'video',
    runId: 'export',
    at: 1,
    value: { type: 'video' as const, assetId: 'a'.repeat(64) },
  }
  addResults(doc, sequence, [output], { adopt: true })
  const record = {
    id: 'delivery',
    resultId: output.id,
    assetId: output.value.assetId,
    runId: output.runId,
    kind: 'film' as const,
    version: 'v1',
    createdAt: 1,
    width: 1280,
    height: 720,
    duration: 2,
    boardId: board,
    sources: [],
    notes: [],
  }
  updateElement(doc, sequence, { deliveries: [record] })
  const scope = { canvasId: 'canvas', boardId: board, sequenceId: sequence }
  const save = (expectedHeads: string[] = []) =>
    appendProductionGoal(doc, {
      scope,
      expectedHeads,
      content: emptyProductionGoal(),
      userId: 'alice',
    })!
  return { doc, board, sequence, scope, save, record, output, node }
}
function reportFor(request: ReturnType<typeof deliveryCheckRequest>): DeliveryCheckReport {
  return {
    format: 'plein-delivery-check',
    version: 1,
    at: 1,
    request,
    rules: DELIVERY_CHECK_RULES,
    engine: 'test-ffmpeg',
    status: 'unchecked',
    checks: (
      ['source', 'decode', 'spec', 'duration', 'audio', 'subtitles', 'black', 'silence'] as const
    ).map((id) => ({ id, status: 'unchecked', detail: '受控状态' })),
    observed: {
      complete: false,
      decodedFrames: 0,
      audioTracks: 0,
      audioDecoded: false,
      black: [],
      silence: [],
    },
    unchecked: ['实际动作未检查'],
  }
}
describe('交付技术报告精确身份', () => {
  it('缺失/冲突目标拒绝执行准备；多个分镜同名不猜，删除后不借同名范围', () => {
    const f = fixture()
    expect(() => deliveryCheckRequest(f.doc, 'canvas', f.sequence, f.record.id, f.board)).toThrow(
      '尚无目标',
    )
    const first = f.save()
    expect(deliveryCheckRequest(f.doc, 'canvas', f.sequence, f.record.id, f.board).goal.id).toBe(
      first.id,
    )
    const remoteRaw = new Y.Doc()
    Y.applyUpdate(remoteRaw, Y.encodeStateAsUpdate(f.doc.ydoc))
    const remote = createDoc(remoteRaw, { schedule: () => {} })
    docs.push(remote)
    const left = f.save([first.id])
    const right = appendProductionGoal(remote, {
      scope: f.scope,
      expectedHeads: [first.id],
      content: { ...emptyProductionGoal(), requirements: '另一离线修订' },
      userId: 'bob',
    })!
    Y.applyUpdate(f.doc.ydoc, Y.encodeStateAsUpdate(remote.ydoc), 'remote')
    expect(() => deliveryCheckRequest(f.doc, 'canvas', f.sequence, f.record.id, f.board)).toThrow(
      '并发修订',
    )
    const merged = f.save([left.id, right.id])
    expect(deliveryCheckRequest(f.doc, 'canvas', f.sequence, f.record.id, f.board).goal.id).toBe(
      merged.id,
    )
    const other = f.node('plein/storyboard', { shots: [Shot.parse({ id: 'other', no: 1 })] })
    appendProductionGoal(f.doc, {
      scope: { ...f.scope, boardId: other },
      expectedHeads: [],
      content: emptyProductionGoal(),
      userId: 'bob',
    })
    expect(() => deliveryCheckRequest(f.doc, 'canvas', f.sequence, f.record.id, undefined)).toThrow(
      '明确选择',
    )
    deleteElements(f.doc, [f.board])
    expect(() => deliveryCheckRequest(f.doc, 'canvas', f.sequence, f.record.id, f.board)).toThrow(
      '明确选择',
    )
  })

  it('输出/目标变版使旧报告仅历史；候选未采用也不能当前，读取零写入', () => {
    const f = fixture(),
      first = f.save()
    const request = deliveryCheckRequest(f.doc, 'canvas', f.sequence, f.record.id, f.board)
    const check = createDeliveryCheck(f.doc, request)
    const result = {
      id: 'report-1',
      port: 'report',
      runId: 'check-run',
      at: 2,
      value: { type: 'json' as const, value: reportFor(request) },
    }
    addResults(f.doc, check, [result], { adopt: true })
    const before = JSON.stringify([...f.doc.elements()])
    let entry = deliveryReports(f.doc, f.sequence)[0]!
    expect(isCurrentDeliveryReport(f.doc, request, entry)).toBe(true)
    expect(JSON.stringify([...f.doc.elements()])).toBe(before)
    f.doc.mutable(check)!.set('adopted', null)
    expect(isCurrentDeliveryReport(f.doc, request, entry)).toBe(false)
    f.doc.mutable(check)!.set('adopted', result.id)
    f.save([first.id])
    expect(isCurrentDeliveryReport(f.doc, request, entry)).toBe(false)
    const now = deliveryCheckRequest(f.doc, 'canvas', f.sequence, f.record.id, f.board)
    setParam(f.doc, check, 'request', now)
    addResults(
      f.doc,
      check,
      [{ ...result, id: 'report-2', at: 3, value: { type: 'json', value: reportFor(now) } }],
      { adopt: false },
    )
    entry = deliveryReports(f.doc, f.sequence).find((item) => item.result.id === 'report-2')!
    expect(isCurrentDeliveryReport(f.doc, now, entry)).toBe(false)
    addResults(
      f.doc,
      f.sequence,
      [
        {
          ...f.output,
          id: 'output-2',
          runId: 'export-2',
          at: 4,
          value: { type: 'video', assetId: 'b'.repeat(64) },
        },
      ],
      { adopt: true },
    )
    expect(isCurrentDeliveryReport(f.doc, now, deliveryReports(f.doc, f.sequence)[0]!)).toBe(false)
    expect(f.doc.get(f.sequence)!.deliveries![0]!.confirmedAt).toBeUndefined()
  })

  it('复制/模板准确映射关联scope且报告原文不改，副本不会当前；readonly禁止创建', () => {
    const f = fixture()
    f.save()
    const request = deliveryCheckRequest(f.doc, 'canvas', f.sequence, f.record.id, f.board)
    request.goal.snapshot = request.goal.snapshot.replace(
      '"requirements":""',
      '"requirements":"@人物#2"',
    )
    const check = createDeliveryCheck(f.doc, request)
    addResults(
      f.doc,
      check,
      [
        {
          id: 'report',
          port: 'report',
          runId: 'run',
          at: 2,
          value: { type: 'json', value: reportFor(request) },
        },
      ],
      { adopt: true },
    )
    const target = createDoc(undefined, { schedule: () => {} })
    docs.push(target)
    const [copiedBoard, copiedSequence, copiedCheck] = referenceClipboard.paste(
      target,
      referenceClipboard.copy(f.doc, [f.board, f.sequence, check]),
      { canvasId: 'destination' },
    )
    const copied = target.get(copiedCheck!)!
    expect(copied.nodeType).toBe(DELIVERY_CHECK_TYPE)
    expect(copied.params?.historical).toBe(true)
    expect((copied.params!.request as typeof request).scope).toEqual({
      canvasId: 'destination',
      boardId: copiedBoard,
      sequenceId: copiedSequence,
    })
    expect((copied.params!.request as typeof request).goal.snapshot).toBe(request.goal.snapshot)
    expect(currentResult(copied)!.value).toEqual(currentResult(f.doc.get(check)!)!.value)
    target.readOnly = true
    expect(() => createDeliveryCheck(target, request)).toThrow()
  })
})
