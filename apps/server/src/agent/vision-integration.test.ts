import { Readable } from 'node:stream'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'
import { expect, it, vi } from 'vite-plus/test'
import { startTestServer } from '../testing'
import { agentTurns } from '../storage/schema'

it('passes completed tool exchanges and actual run identities into the following builtin turn', async () => {
  const running = await startTestServer()
  const { agents, plugins, db } = running.server
  const res = await fetch(`${running.url}/api/canvases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const canvas = (await res.json()) as { id: string }
  const session = agents.create(canvas.id, 'local', 'builtin')
  const send = async (text: string) => {
    const idle = new Promise<void>((resolve) => {
      const off = agents.subscribe(session.id, (e) => {
        if (e.type === 'status' && e.status === 'idle') {
          off()
          resolve()
        }
      })
    })
    await agents.send(session.id, 'local', text)
    await idle
  }
  await send('画一张夜景')
  const first = db.select().from(agentTurns).where(eq(agentTurns.session_id, session.id)).get()!
  const runId = (JSON.parse(first.execution) as { runs: Array<{ runId: string }> }).runs[0]!.runId
  const calls = vi.spyOn(plugins, 'call')
  try {
    await send('现在有哪些元素')
    const request = calls.mock.calls.find((args) => args[0] === 'text.chat')![2] as {
      messages: Array<{ role: string; toolName?: string; content: unknown }>
    }
    expect(
      request.messages.some(
        (message) => message.role === 'tool' && message.toolName === 'run_node',
      ),
    ).toBe(true)
    expect(JSON.stringify(request.messages)).toContain(runId)
    const turns = db.select().from(agentTurns).where(eq(agentTurns.session_id, session.id)).all()
    expect(turns).toHaveLength(2)
    expect(turns.map((t) => (JSON.parse(t.execution) as { runs: unknown[] }).runs.length)).toEqual([
      1, 0,
    ])
  } finally {
    calls.mockRestore()
  }
})

it('vision mock reads an owner-scoped preview through PluginHost and records only asset refs', async () => {
  const running = await startTestServer()
  const { agents, assets, plugins, db } = running.server
  const res = await fetch(`${running.url}/api/canvases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const canvas = (await res.json()) as { id: string }
  plugins.configs.setDefaultModel('text.chat', 'plein/mock:agent-vision')
  const data = await sharp({
    create: { width: 24, height: 16, channels: 3, background: '#377ab8' },
  })
    .png()
    .toBuffer()
  const asset = await assets.ingest('local', Readable.from([data]), {
    mime: 'image/png',
    name: 'reference',
  })
  const session = agents.create(canvas.id, 'local', 'builtin')
  const idle = new Promise<void>((resolve) => {
    const off = agents.subscribe(session.id, (e) => {
      if (e.type === 'status' && e.status === 'idle') {
        off()
        resolve()
      }
    })
  })
  await agents.send(session.id, 'local', `查看 ASSET=${asset.id}`)
  await idle
  expect(
    agents
      .get(session.id, 'local')!
      .items.some((item) => item.type === 'text' && item.text.includes('实际收到 1 张')),
  ).toBe(true)
  const row = db.select().from(agentTurns).where(eq(agentTurns.session_id, session.id)).get()!
  expect(row.state).toBe('completed')
  expect(row.transcript).toContain('"assetId"')
  expect(row.transcript).toContain(`source_asset_id=${asset.id}`)
  expect(row.transcript).not.toContain('base64')
  expect(row.execution).not.toContain('"data":')
  const another = agents.create(canvas.id, 'local', 'builtin')
  const failed = new Promise<void>((resolve) => {
    const off = agents.subscribe(another.id, (e) => {
      if (e.type === 'status' && e.status === 'idle') {
        off()
        resolve()
      }
    })
  })
  const privateAsset = await assets.ingest(
    'other-owner',
    Readable.from([await sharp(data).negate().png().toBuffer()]),
    { mime: 'image/png', name: 'private' },
  )
  await agents.send(another.id, 'local', `查看 ASSET=${privateAsset.id}`)
  await failed
  expect(
    agents
      .get(another.id, 'local')!
      .items.some(
        (item) => item.type === 'tool' && item.name === 'view_media' && item.status === 'error',
      ),
  ).toBe(true)
})
