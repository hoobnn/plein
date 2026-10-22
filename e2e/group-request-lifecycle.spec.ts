import { expect, type Page, test } from '@playwright/test'
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
async function back(page: Page, f: Awaited<ReturnType<typeof fixture>>) {
  await page.goto(`/#/c/${f.other}`)
  await waitEngine(page)
  await page.goto(`/#/c/${f.origin}`)
  await waitEngine(page)
  await page.evaluate((id) => window.__plein.engine.selection.set([id]), f.frame)
  await zoomTo(page, [f.frame])
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

test('旧整组受理应答在切回重跑后才到达，停止入口仍对应当前批次', async ({ page }) => {
  const f = await fixture(page)
  let release!: () => void,
    oldReady = false,
    oldFinished = false,
    count = 0
  let oldGroup = '',
    currentGroup = ''
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/api/canvases/${f.origin}/frames/${f.frame}/run`, async (route) => {
    const index = ++count,
      response = await route.fetch(),
      body = await response.json()
    expect(response.status()).toBe(202)
    if (index === 1) {
      oldGroup = body.groupId
      oldReady = true
      await gate
    } else currentGroup = body.groupId
    await route.fulfill({ response }).catch(() => {})
    if (index === 1) oldFinished = true
  })
  try {
    const toolbar = page.getByRole('toolbar', { name: 'Frame 操作', exact: true })
    await toolbar.getByRole('button', { name: '运行整组（1）', exact: true }).click()
    await expect.poll(() => oldReady).toBe(true)
    await expect
      .poll(
        async () => (await (await page.request.get(`/api/runs/groups/${oldGroup}`)).json()).status,
      )
      .toBe('done')
    await back(page, f)
    await delayedProvider(page, f.provider)
    await toolbar.getByLabel('全部重跑', { exact: true }).check()
    await toolbar.getByRole('button', { name: '运行整组（1）', exact: true }).click()
    await expect.poll(() => currentGroup).not.toBe('')
    expect(currentGroup).not.toBe(oldGroup)
    const stop = toolbar.getByRole('button', { name: '停止运行', exact: true })
    await expect(stop).toBeEnabled()
    release()
    await expect.poll(() => oldFinished).toBe(true)
    await settle(page)
    const canceled: string[] = []
    page.on('request', (request) => {
      if (/\/api\/runs\/groups\/[^/]+\/cancel$/.test(request.url()))
        canceled.push(request.url().split('/').at(-2)!)
    })
    await stop.click()
    await expect.poll(() => canceled.length).toBe(1)
    expect(canceled).toEqual([currentGroup])
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/runs/groups/${currentGroup}`)).json()).status,
      )
      .toBe('canceled')
    await expect(toolbar.getByRole('button', { name: '运行整组（1）', exact: true })).toBeVisible()
    await page.screenshot({
      path: test.info().outputPath('current-group-stopped.png'),
      animations: 'disabled',
    })
  } finally {
    release()
    if (currentGroup) await page.request.post(`/api/runs/groups/${currentGroup}/cancel`)
    await page.request.put('/api/providers/plein/mock/config', {
      data: { settings: f.provider.settings },
    })
  }
})
for (const [kind, when] of [
  ['node', 'back'],
  ['group', 'back'],
  ['group', 'away'],
] as const) {
  const where = when === 'back' ? '切回同一画布后' : '停在另一画布时'
  const target = when === 'back' ? '新引擎' : '另一画布'
  test(`停止${kind === 'node' ? '节点' : '整组'}失败应答在${where}才返回，不提示到${target}`, async ({
    page,
  }) => {
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
      const url =
        kind === 'node'
          ? `/api/canvases/${f.origin}/nodes/${f.node}/cancel`
          : `/api/runs/groups/${group}/cancel`
      await page.route(`**${url}`, async (route) => {
        entered = true
        await gate
        await route.fulfill({ status: 503, json: { message: '测试旧停止失败' } }).catch(() => {})
        finished = true
      })
      await page.getByRole('button', { name: '任务', exact: true }).click()
      const tasks = page.getByRole('complementary', { name: '任务', exact: true })
      await tasks
        .getByRole('button', { name: kind === 'node' ? '停止' : '停止整组', exact: true })
        .click()
      await expect.poll(() => entered).toBe(true)
      if (when === 'back') await back(page, f)
      else {
        await page.goto(`/#/c/${f.other}`)
        await waitEngine(page)
      }
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
}
