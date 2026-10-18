import { expect, type Page, test } from '@playwright/test'
import { newProject, waitEngine } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const canvasId = page.url().split('/').at(-1)!
  const canvas = await (await page.request.get(`/api/canvases/${canvasId}`)).json()
  const uploaded = await page.request.post('/api/assets', {
    headers: { 'content-type': 'image/png', 'x-file-name': 'placement.png' },
    data: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAYklEQVR4nO3PUQkAIBTAwBfFqDbXEH4cwmABbnP2+rrhgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACx67GbZ1HuLZqnQAAAAASUVORK5CYII=',
      'base64',
    ),
  })
  expect(uploaded.ok()).toBe(true)
  const asset = (await uploaded.json()).id as string
  const created = await page.request.post('/api/library', {
    data: {
      kind: 'prop',
      name: '等待参考图的水杯',
      projectId: canvas.projectId,
      images: [{ slot: 'main', assetId: asset }],
    },
  })
  expect(created.ok()).toBe(true)
  const item = await created.json()
  // 重新进入页面读取刚创建的条目，缓存中尚无素材元信息。
  await page.reload()
  await waitEngine(page)
  const sidebar = page.getByRole('complementary', { name: '侧栏', exact: true })
  await sidebar.getByRole('tab', { name: '资产', exact: true }).click()
  const row = sidebar.getByRole('button').filter({ hasText: item.name })
  await expect(row).toBeVisible()
  let resume!: () => void
  const held = new Promise<void>((resolve) => {
    resume = resolve
  })
  let requested = false
  await page.route(`**/api/assets/${asset}/meta`, async (route) => {
    requested = true
    await held
    await route.continue()
  })
  const cards = () =>
    page.evaluate(
      (id) =>
        [...window.__plein.engine.doc.elements()]
          .filter((el) => el.params?.libraryId === id)
          .map((el) => el.id),
      item.id,
    )
  return { row, sidebar, item, asset, resume, requested: () => requested, cards }
}

test('慢速素材读取期间重复点击不重复铺卡，显示放入进度并关联正确素材', async ({ page }) => {
  const f = await fixture(page)
  try {
    await f.row.dblclick()
    await expect.poll(f.requested).toBe(true)
    await expect(f.row).toBeDisabled()
    await expect(f.row).toContainText('正在放入')
    expect(await f.cards()).toEqual([])
    await f.sidebar.screenshot({
      path: test.info().outputPath('library-placement-pending.png'),
      animations: 'disabled',
    })
  } finally {
    f.resume()
  }
  await expect.poll(f.cards).toHaveLength(1)
  await expect(f.row).toBeEnabled()
  await expect(f.row).toContainText('已在画布')
  const [id] = await f.cards()
  const references = await page.evaluate((id) => {
    const { doc } = window.__plein.engine
    return [...doc.edges()]
      .filter((edge) => edge.to[0] === id)
      .map((edge) => doc.get(edge.from[0])?.assetId)
  }, id!)
  expect(references).toEqual([f.asset])
})

test('等待素材时切换画布不再修改旧画布或把迟到结果提示到新画布', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const f = await fixture(page)
  const next = await (
    await page.request.post('/api/projects', { data: { title: '放置切换目标' } })
  ).json()
  await page.evaluate(() => {
    const doc = window.__plein.engine.doc
    const engine = window.__plein.engine
    ;(window as unknown as { oldPlacementCount(): number }).oldPlacementCount = () =>
      [...doc.elements()].length
    ;(window as unknown as { oldPlacementActive(): boolean }).oldPlacementActive = () =>
      window.__plein?.engine === engine
  })
  try {
    await f.row.click()
    await expect.poll(f.requested).toBe(true)
    await page.evaluate((id) => {
      location.hash = `#/c/${id}`
    }, next.lastCanvasId)
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { oldPlacementActive(): boolean }).oldPlacementActive(),
        ),
      )
      .toBe(false)
    await waitEngine(page)
    await expect(page).toHaveURL(new RegExp(next.lastCanvasId))
  } finally {
    f.resume()
  }
  await page.waitForLoadState('networkidle')
  expect(
    await page.evaluate(() =>
      (window as unknown as { oldPlacementCount(): number }).oldPlacementCount(),
    ),
  ).toBe(0)
  expect(await f.cards()).toEqual([])
  await expect(page.locator('.ui-toast').filter({ hasText: f.item.name })).toHaveCount(0)
  expect(errors).toEqual([])
})

for (const entry of ['列表', '编辑档案']) {
  test(`资产库从${entry}放入时关闭并重新打开，不被迟到结果关闭，之后仍可重试`, async ({ page }) => {
    const f = await fixture(page)
    const panel = page.getByRole('dialog', { name: '资产库', exact: true })
    await f.sidebar.getByRole('button', { name: '打开资产库', exact: true }).click()
    await panel.getByRole('button', { name: '道具', exact: true }).click()
    await panel.getByRole('button', { name: '本项目', exact: true }).click()
    const card = panel.getByRole('listitem').filter({ hasText: f.item.name })
    try {
      if (entry === '编辑档案') {
        await card.getByRole('button').first().click()
        await panel.getByRole('button', { name: '添加到画布', exact: true }).click()
      } else {
        await card.hover()
        await card.getByRole('button', { name: '添加到画布', exact: true }).click()
      }
      await expect.poll(f.requested).toBe(true)
      await expect(panel.getByRole('button', { name: '正在放入…', exact: true })).toBeDisabled()
      await panel.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(panel).toBeHidden()
      await f.sidebar.getByRole('button', { name: '打开资产库', exact: true }).click()
      await expect(panel).toBeVisible()
    } finally {
      f.resume()
    }
    await page.waitForLoadState('networkidle')
    await expect(panel).toBeVisible()
    expect(await f.cards()).toEqual([])
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
    await f.row.click()
    await expect.poll(f.cards).toHaveLength(1)
  })
}
