import type { AgentItem, AgentSession } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { bootServer, createCanvas, request, until } from '../testing'

type Approval = Extract<AgentItem, { type: 'approval' }>

async function setup() {
  const f = await bootServer()
  const { id: canvasId, doc } = await createCanvas(f.server)
  const created = await request(f.server, `/api/canvases/${canvasId}/agent/sessions`, {
    method: 'POST',
    body: JSON.stringify({ agent: 'builtin' }),
  })
  expect(created.status).toBe(201)
  const session = (await created.json()) as AgentSession
  const path = `/api/agent/sessions/${session.id}`
  const send = (text: string, plan = false) =>
    request(f.server, `${path}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text, approval: 'always', plan }),
    })
  const read = () => f.server.agents.get(session.id, 'local')!
  return { ...f, canvasId, doc, session, path, send, read }
}

describe('审批与停止的持久化合同', () => {
  it.each(['allow', 'skip', 'stop'] as const)(
    '%s 只执行用户选择，停止后重启与续聊不重跑旧任务',
    async (choice) => {
      const f = await setup()
      try {
        expect((await f.send('画一张雨夜天台')).status).toBe(202)
        const approval = await until(() =>
          f
            .read()
            .items.find(
              (item): item is Approval => item.type === 'approval' && item.status === 'pending',
            ),
        )
        const node = [...f.doc.elements()].find((item) => item.nodeType === 'plein/image')!
        expect(node).toBeDefined()
        expect(node.results ?? []).toHaveLength(0)
        expect(f.server.runs.list(f.canvasId, 100).jobs).toHaveLength(0)
        const decision = await request(
          f.server,
          choice === 'stop' ? `${f.path}/stop` : `${f.path}/approvals/${approval.id}`,
          {
            method: 'POST',
            ...(choice === 'stop' ? {} : { body: JSON.stringify({ allow: choice === 'allow' }) }),
          },
        )
        expect(decision.status).toBe(204)
        await until(() => f.read().status === 'idle')
        const settled = f.read()
        expect(settled.items.find((item) => item.id === approval.id)).toMatchObject({
          status: choice === 'allow' ? 'approved' : choice === 'skip' ? 'denied' : 'expired',
        })
        expect(f.doc.get(node.id)?.results ?? []).toHaveLength(choice === 'allow' ? 1 : 0)
        expect(f.server.runs.list(f.canvasId, 100).jobs).toHaveLength(choice === 'allow' ? 1 : 0)
        if (choice === 'stop') {
          expect(settled.lastTurn).toMatchObject({ state: 'stopped', reason: 'user_stopped' })
          expect(settled.items).toContainEqual(
            expect.objectContaining({ type: 'notice', text: '已停止' }),
          )
          expect(settled.items.some((item) => item.type === 'error')).toBe(false)
          expect(settled.items).toContainEqual(
            expect.objectContaining({ type: 'tool', name: 'await_approval', status: 'stopped' }),
          )
          f.doc.destroy()
          await f.close()
          const reopened = await bootServer({ dataDir: f.dataDir })
          try {
            const restored = (await (await request(reopened.server, f.path)).json()) as AgentSession
            expect(restored.lastTurn).toEqual(settled.lastTurn)
            expect(restored.items.filter((item) => item.type !== 'changes')).toEqual(
              JSON.parse(JSON.stringify(settled.items.filter((item) => item.type !== 'changes'))),
            )
            expect(restored.items.find((item) => item.type === 'changes')).toMatchObject({
              undoable: false,
            })
            expect(
              (
                await request(reopened.server, `${f.path}/messages`, {
                  method: 'POST',
                  body: JSON.stringify({ text: '你好', approval: 'always' }),
                })
              ).status,
            ).toBe(202)
            await until(() => reopened.server.agents.get(f.session.id, 'local')?.status === 'idle')
            const resumed = reopened.server.agents.get(f.session.id, 'local')!
            expect(resumed.lastTurn).toMatchObject({ state: 'completed' })
            expect(resumed.lastTurn?.id).not.toBe(settled.lastTurn?.id)
            expect(reopened.server.runs.list(f.canvasId, 100).jobs).toHaveLength(0)
            expect(
              reopened.server.rooms.withDoc(f.canvasId, (doc) =>
                [...doc.elements()].map((item) => ({ id: item.id, results: item.results ?? [] })),
              ),
            ).toEqual([{ id: node.id, results: [] }])
          } finally {
            await reopened.close()
          }
        }
      } finally {
        if (choice !== 'stop') f.doc.destroy()
        await f.close()
      }
    },
  )

  it('计划与每次运行确认串行等待，批准计划不隐含批准生成', async () => {
    const f = await setup()
    try {
      expect((await f.send('画一张雨夜天台', true)).status).toBe(202)
      const plan = await until(() =>
        f.read().items.find((item) => item.type === 'plan' && item.status === 'pending'),
      )
      expect([...f.doc.elements()]).toHaveLength(0)
      expect(
        (
          await request(f.server, `${f.path}/approvals/${plan.id}`, {
            method: 'POST',
            body: JSON.stringify({ allow: true }),
          })
        ).status,
      ).toBe(204)
      const approval = await until(() =>
        f.read().items.find((item) => item.type === 'approval' && item.status === 'pending'),
      )
      expect(f.server.runs.list(f.canvasId, 100).jobs).toHaveLength(0)
      expect(f.read().items.find((item) => item.id === plan.id)).toMatchObject({
        steps: [{ status: 'done' }, { status: 'doing' }],
      })
      expect(
        (
          await request(f.server, `${f.path}/approvals/${approval.id}`, {
            method: 'POST',
            body: JSON.stringify({ allow: true }),
          })
        ).status,
      ).toBe(204)
      await until(() => f.read().status === 'idle')
      expect(f.read().items.find((item) => item.id === plan.id)).toMatchObject({
        status: 'approved',
        steps: [{ status: 'done' }, { status: 'done' }],
      })
      expect(f.server.runs.list(f.canvasId, 100).jobs).toHaveLength(1)
    } finally {
      f.doc.destroy()
      await f.close()
    }
  })
})
