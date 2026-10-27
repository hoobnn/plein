import { expandShots } from '@plein/capabilities'
import { setParam } from '@plein/doc'
import { Shot } from '@plein/nodes'
import { API, type StoryboardBatchPlan } from '@plein/protocol'
import { mockProvider } from '@plein/providers'
import { afterEach, expect, it, vi } from 'vite-plus/test'
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

it('重名角色绑定后移动台词，预检与实际提交仍使用各自音色及文本', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id: canvas, doc } = await createCanvas(server)
  const speakers = ['mock-female', 'mock-male'].map((voiceId) =>
    addNode(doc, 'plein/character', {
      name: '同名角色',
      params: { voice: { provider: 'plein/mock', voiceId } },
    }),
  )
  const shot = Shot.parse({
    id: 'one',
    no: 1,
    dialogue: speakers.map((elementId, i) => ({
      id: `line-${i}`,
      character: '同名角色',
      line: `台词${i}`,
      speaker: { elementId },
    })),
  })
  const board = addNode(doc, 'plein/storyboard', { params: { shots: [shot] } })
  expandShots(doc, board, [shot.id], makeNode)
  setParam(doc, board, 'shots', [{ ...shot, dialogue: [...shot.dialogue].reverse() }])
  expandShots(doc, board, [shot.id], makeNode, { mode: 'update' })
  const submit = vi.spyOn(mockProvider, 'submit')
  const response = await request(server, API.storyboardBatchPreview(canvas, board), {
    method: 'POST',
    body: JSON.stringify({ shotIds: [shot.id], role: 'speech', reuseExisting: false }),
  })
  expect(response.status).toBe(200)
  const plan = (await response.json()) as StoryboardBatchPlan
  expect(submit).not.toHaveBeenCalled()
  const rows = plan.rows.filter((row) => row.action === 'run')
  expect(rows).toHaveLength(2)
  for (const row of rows) {
    const source = doc.get(row.nodeId!)!.params!.source as { dialogueId: string }
    const first = source.dialogueId === 'line-0'
    expect(row.input).toMatchObject({
      prompt: first ? '台词0' : '台词1',
      voice: { provider: 'plein/mock', voiceId: first ? 'mock-female' : 'mock-male' },
    })
  }
  const started = await request(server, API.storyboardBatchCommit(canvas, board), {
    method: 'POST',
    body: JSON.stringify({ token: plan.token }),
  })
  expect(started.status).toBe(202)
  const group = (await started.json()) as { groupId: string; total: number }
  expect(group.total).toBe(2)
  await until(() => server.runs.groupState(group.groupId, 'local')?.status === 'done')
  expect(server.runs.groupState(group.groupId, 'local')?.summary?.succeeded).toBe(2)
  expect(submit).toHaveBeenCalledTimes(2)
  const inputs = submit.mock.calls.map(([request]) => request.input)
  expect(inputs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: '台词0', voice: 'mock-female' }),
      expect.objectContaining({ text: '台词1', voice: 'mock-male' }),
    ]),
  )
  for (const row of rows) expect(doc.get(row.nodeId!)!.results).toHaveLength(1)
})
