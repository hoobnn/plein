import { expect, test } from '@playwright/test'
import { elements, newProject } from './canvas'

test('外部 Agent 通过当前画布客户端截取 3D 构图，结果与来源同步到画布', async ({ page }) => {
  await newProject(page)
  const canvas = new URL(page.url()).hash.split('/').at(-1)!
  const issued = await page.request.post('/api/mcp/external')
  expect(issued.ok()).toBeTruthy()
  const { token } = (await issued.json()) as { token: string }
  let callId = 0
  async function call(name: string, args: Record<string, unknown> = {}) {
    const response = await page.request.post('/mcp', {
      headers: { authorization: `Bearer ${token}` },
      data: {
        jsonrpc: '2.0',
        id: ++callId,
        method: 'tools/call',
        params: { name, arguments: { canvas_id: canvas, ...args } },
      },
      timeout: 50_000,
    })
    expect(response.ok()).toBeTruthy()
    const body = (await response.json()) as {
      result: { isError?: boolean; content: Array<{ type: string; text?: string }> }
    }
    const text = body.result.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
    expect(body.result.isError, text).not.toBe(true)
    return JSON.parse(text)
  }
  const stage = (await call('create_node', { type: 'plein/stage', name: 'Agent 构图' })) as {
    id: string
  }
  await expect.poll(async () => (await elements(page)).some((e) => e.id === stage.id)).toBe(true)
  const shot = (await call('capture_stage', { id: stage.id })) as {
    asset_id: string
    result_id: string
  }
  expect(shot.asset_id).toMatch(/^[0-9a-f]{64}$/)
  const metaResponse = await page.request.get(`/api/assets/${shot.asset_id}/meta`)
  const meta = (await metaResponse.json()) as { kind: string; width: number; height: number }
  expect(meta.kind).toBe('image')
  expect(Math.max(meta.width, meta.height)).toBe(1536)
  const node = (await call('get_element', { id: stage.id })) as {
    results: Array<{ result_id: string }>
    params: { snapshots: Array<{ resultId: string; assetId: string }> }
  }
  expect(node.results.some((r) => r.result_id === shot.result_id)).toBe(true)
  expect(node.params.snapshots[0]).toMatchObject({
    resultId: shot.result_id,
    assetId: shot.asset_id,
  })
  const actions = (await call('list_canvas_actions')) as Array<{ action: string }>
  expect(actions.some((a) => a.action === 'capture_panorama')).toBe(true)
  expect(actions.some((a) => a.action === 'recognize_subtitles')).toBe(true)
  await page.screenshot({
    path: test.info().outputPath('agent-stage-capture.png'),
    animations: 'disabled',
  })
})
