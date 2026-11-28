import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { clickElement, elements, newProject, waitEngine } from './canvas'

async function canvasClient(page: Page, canvas?: string) {
  const issued = await page.request.post('/api/mcp/external')
  expect(issued.ok()).toBeTruthy()
  const { token } = (await issued.json()) as { token: string }
  let callId = 0
  return async function call(name: string, args: Record<string, unknown> = {}) {
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
    // 写操作的结果后面会附一段 undo_token 提示文本；JSON 结果始终是第一段
    const text = body.result.content.find((c) => c.type === 'text')?.text ?? ''
    expect(body.result.isError, text).not.toBe(true)
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
}

test(
  '外部 Agent 通过当前画布客户端截取 3D 构图，结果与来源同步到画布',
  { tag: '@core' },
  async ({ page }) => {
    await newProject(page)
    const canvas = new URL(page.url()).hash.split('/').at(-1)!
    const call = await canvasClient(page, canvas)
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
  },
)

test('外部助手搜索画布，适应视野，再从指定窗口打开目标', { tag: '@core' }, async ({ page }) => {
  await newProject(page)
  const source = new URL(page.url()).hash.split('/').at(-1)!
  const call = await canvasClient(page)
  const title = `MCP 导航 ${source}`
  const { canvas_id: target } = await call('create_canvas', { title })
  const items = await call('list_canvases', { query: title.toLowerCase() })
  expect(items).toMatchObject([{ id: target, open_path: `/#/c/${target}` }])
  expect(page.url()).toContain(source)
  const { id } = await call('create_element', {
    kind: 'markdown',
    canvas_id: source,
    text: '取景标记',
  })
  await expect.poll(async () => (await elements(page)).some((el) => el.id === id)).toBe(true)
  await expect
    .poll(async () => typeof (await call('ui_get_viewport', { canvas_id: source })).total)
    .toBe('number')
  await call('ui_set_viewport', { canvas_id: source, x: 100000, y: 100000, zoom: 1 })
  await expect
    .poll(async () => (await call('ui_get_viewport', { canvas_id: source })).viewport[0])
    .toBeGreaterThan(90000)
  await call('ui_focus', { canvas_id: source })
  await expect
    .poll(async () => (await call('ui_get_viewport', { canvas_id: source })).total)
    .toBeGreaterThan(0)
  const active = await page.context().newPage()
  await active.goto(page.url())
  await active.bringToFront()
  await waitEngine(active)
  await clickElement(active, id)
  await expect
    .poll(async () => (await call('ui_get_selection', { canvas_id: source })).elements)
    .toMatchObject([{ id }])
  const opened = await call('open_canvas', { canvas_id: target, from_canvas_id: source })
  expect(opened).toMatchObject({ canvas_id: target, status: 'sent', open_path: `/#/c/${target}` })
  await expect(active).toHaveURL(new RegExp(`/#/c/${target}$`))
  await expect(page).toHaveURL(new RegExp(`/#/c/${source}$`))
})
