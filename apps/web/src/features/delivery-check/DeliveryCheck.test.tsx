// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import {
  addResults,
  appendProductionGoal,
  createDoc,
  createElement,
  emptyProductionGoal,
  updateElement,
  type DeliveryRecord,
} from '@plein/doc'
import { DELIVERY_CHECK_RULES, type DeliveryCheckReport } from '@plein/nodes'
import { afterEach, expect, it } from 'vite-plus/test'
import { useDocVersion } from '../../canvas/hooks'
import { useCanvas } from '../../stores/canvas'
import { useSession } from '../../stores/session'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, screen, waitFor } from '../../testing/render'
import { DeliveryCheck } from './DeliveryCheck'
import { createDeliveryCheck, deliveryCheckRequest } from './model'

const docs: ReturnType<typeof createDoc>[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))
function setup() {
  const doc = createDoc(undefined, { schedule: () => {} })
  docs.push(doc)
  const node = (nodeType: string, params = {}) =>
    createElement(doc, { kind: 'node', nodeType, params, x: 0, y: 0, w: 100, h: 100 })
  const board = node('plein/storyboard', { shots: [{ id: 'shot', no: 1 }] }),
    id = node('plein/sequence')
  const record: DeliveryRecord = {
    id: 'delivery',
    resultId: 'result',
    runId: 'run',
    assetId: 'a'.repeat(64),
    kind: 'film',
    version: 'v1',
    createdAt: 1,
    width: 1280,
    height: 720,
    duration: 2,
    boardId: board,
    sources: [],
    notes: [],
    confirmedAt: 1,
  }
  addResults(
    doc,
    id,
    [
      {
        id: record.resultId,
        port: 'video',
        runId: record.runId,
        at: 1,
        value: { type: 'video', assetId: record.assetId },
      },
    ],
    { adopt: true },
  )
  updateElement(doc, id, { deliveries: [record] })
  appendProductionGoal(doc, {
    scope: { canvasId: 'canvas', boardId: board, sequenceId: id },
    expectedHeads: [],
    content: emptyProductionGoal(),
    userId: 'local',
  })
  const engine = { doc } as Engine
  useCanvas.setState({ engine, canvasId: 'canvas', sequence: id })
  useSession.setState({
    info: { principal: { id: 'local', role: 'owner' }, authRequired: false, needsSetup: false },
  })
  function Check() {
    useDocVersion(doc)
    return (
      <DeliveryCheck engine={engine} node={doc.get(id)!} record={doc.get(id)!.deliveries![0]!} />
    )
  }
  const request = deliveryCheckRequest(doc, 'canvas', id, record.id, undefined)
  const view = renderApp(<Check />)
  return { ...view, doc, id, request, record }
}

it.each(['output', 'readonly'] as const)(
  '预检等待期间 %s 变化拒绝迟到执行，原交付确认不变',
  async (mode) => {
    const f = setup()
    let release!: (response: Response) => void
    let checkedId = ''
    const reads: string[] = []
    mockFetch((request) => {
      const path = new URL(request.url).pathname
      if (request.method === 'GET' && path.endsWith('/input')) {
        reads.push(path)
        checkedId = path.split('/').at(-2)!
        return new Promise<Response>((resolve) => {
          release = resolve
        })
      }
    })
    await f.user.click(screen.getByRole('button', { name: '执行免费本地技术检查' }))
    await waitFor(() => expect(reads).toHaveLength(1))
    expect(
      (screen.getByRole('button', { name: '核对固定输入…' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    act(() => {
      if (mode === 'readonly') f.doc.readOnly = true
      else updateElement(f.doc, f.id, { deliveries: [{ ...f.record, assetId: 'b'.repeat(64) }] })
      f.doc.flush()
    })
    await act(async () =>
      release(
        Response.json({ status: 'ready', inputHash: 'hash', params: { request: f.request } }),
      ),
    )
    expect(screen.getByRole('alert').textContent).toMatch(
      mode === 'readonly' ? /未开始本地检查/ : /输出或目标版本已变化/,
    )
    expect(f.doc.get(checkedId)!.run).toBeUndefined()
    expect(f.doc.get(f.id)!.deliveries![0]!.confirmedAt).toBe(1)
  },
)

it.each([
  ['passed', '通过'],
  ['issues', '问题'],
  ['unchecked', '未检查'],
  ['failed', '检查失败'],
] as const)('报告 %s 显示真实状态和未检查边界，打开零执行', (status, label) => {
  const f = setup()
  expect(screen.getByText('尚无技术报告。打开本面板不会执行检查。')).toBeTruthy()
  act(() => {
    const id = createDeliveryCheck(f.doc, f.request)
    const report: DeliveryCheckReport = {
      format: 'plein-delivery-check',
      version: 1,
      at: 1,
      request: f.request,
      rules: DELIVERY_CHECK_RULES,
      engine: 'test',
      status,
      checks: (
        ['source', 'decode', 'spec', 'duration', 'audio', 'subtitles', 'black', 'silence'] as const
      ).map((id) => ({ id, status, detail: '实际文件检查' })),
      observed: {
        sha256: f.record.assetId,
        complete: status === 'passed',
        decodedFrames: 20,
        audioTracks: 1,
        audioDecoded: true,
        black: [],
        silence: [],
        audioUncovered: status === 'passed' ? [] : [{ start: 0, end: 0.5 }],
      },
      unchecked: ['动作和对白语义需要人工检查'],
    }
    addResults(
      f.doc,
      id,
      [
        {
          id: 'report',
          port: 'report',
          runId: 'check',
          at: 1,
          value: { type: 'json', value: report },
        },
      ],
      { adopt: true },
    )
    f.doc.flush()
  })
  expect(screen.getByTestId('delivery-check-report').textContent).toContain(`技术范围${label}`)
  if (status !== 'passed') expect(screen.getByText('音频样本未覆盖区间（未检查）')).toBeTruthy()
  expect(screen.getByText('动作和对白语义需要人工检查')).toBeTruthy()
  expect(f.doc.get(f.id)!.deliveries).toEqual([f.record])
})
