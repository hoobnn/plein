import { expect, type Page, test } from './fixtures'
import { newProject, waitEngine, zoomTo } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const origin = decodeURIComponent(page.url().split('#/c/')[1]!)
  const ids = await page.evaluate(() => {
    const node = window.__plein.addNode({
      type: 'plein/image',
      name: '整组受理水杯',
      params: { prompt: '透明水杯', model: 'plein/mock:image' },
      x: 300,
      y: 200,
    })
    const engine = window.__plein.engine as typeof window.__plein.engine & {
      groupSelection(): void
    }
    engine.selection.set([node])
    engine.groupSelection()
    return { node, frame: engine.selection.values()[0]! }
  })
  const peer = await page.context().newPage()
  try {
    await peer.goto(page.url())
    await waitEngine(peer)
    await expect
      .poll(() => peer.evaluate((id) => !!window.__plein.engine.doc.get(id), ids.frame))
      .toBe(true)
  } finally {
    await peer.close()
  }
  const canvas = await (await page.request.get(`/api/canvases/${origin}`)).json()
  const other = await (
    await page.request.post('/api/canvases', {
      data: { projectId: canvas.projectId, title: '整组等待的新画布' },
    })
  ).json()
  const provider = await (await page.request.get('/api/providers/plein/mock/config')).json()
  await zoomTo(page, [ids.frame])
  return { ...ids, origin, other: other.id as string, provider }
}
async function delayedProvider(page: Page, provider: { settings: Record<string, unknown> }) {
  expect(
    (
      await page.request.put('/api/providers/plein/mock/config', {
        data: { settings: { ...provider.settings, latencyMs: 60_000 } },
      })
    ).ok(),
  ).toBe(true)
}
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )

test('停止整组失败应答在停在另一画布时才返回，不提示到另一画布', async ({ page }) => {
  const f = await fixture(page)
  await delayedProvider(page, f.provider)
  let group = '',
    release!: () => void,
    entered = false,
    finished = false
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    const started = await page.request.post(`/api/canvases/${f.origin}/frames/${f.frame}/run`, {
      data: {},
    })
    expect(started.status()).toBe(202)
    group = (await started.json()).groupId
    const url = `/api/runs/groups/${group}/cancel`
    await page.route(`**${url}`, async (route) => {
      entered = true
      await gate
      await route.fulfill({ status: 503, json: { message: '测试旧停止失败' } }).catch(() => {})
      finished = true
    })
    await page.getByRole('button', { name: '任务', exact: true }).click()
    const tasks = page.getByRole('complementary', { name: '任务', exact: true })
    await tasks.getByRole('button', { name: '停止整组', exact: true }).click()
    await expect.poll(() => entered).toBe(true)
    await page.goto(`/#/c/${f.other}`)
    await waitEngine(page)
    release()
    await expect.poll(() => finished).toBe(true)
    await settle(page)
    expect((await page.locator('.ui-toast').allTextContents()).join('')).not.toContain(
      '测试旧停止失败',
    )
  } finally {
    release()
    if (group) await page.request.post(`/api/runs/groups/${group}/cancel`)
    await page.request.put('/api/providers/plein/mock/config', {
      data: { settings: f.provider.settings },
    })
  }
})
