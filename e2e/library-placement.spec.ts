import { openLibraryPanel } from './library-ui'
import { expect, type Page, test } from '@playwright/test'
import { newProject, waitEngine } from './canvas'

async function fixture(page: Page, failure?: 'http' | 'network') {
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
    if (failure === 'http')
      return route.fulfill({
        status: 503,
        json: { error: 'temporary_failure', message: '素材服务暂不可用' },
      })
    if (failure === 'network') return route.abort('failed')
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
  return {
    row,
    sidebar,
    item,
    asset,
    resume,
    recover: () => {
      failure = undefined
    },
    requested: () => requested,
    cards,
  }
}

for (const failure of ['http', 'network'] as const) {
  test(`素材 ${failure} 失败不丢失参考图，反馈失败后可直接重试`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 560 })
    const f = await fixture(page, failure)
    const resize = f.sidebar.getByRole('separator', { name: '调整侧栏宽度', exact: true })
    await resize.focus()
    await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.press('Shift+ArrowLeft')
    f.resume()
    await f.row.click()
    await expect(page.locator('.ui-toast')).toContainText('放入资产失败')
    await expect(f.sidebar.getByRole('alert')).toContainText('点击条目重试')
    await expect(f.row).toBeEnabled()
    await expect(f.row).not.toContainText('已在画布')
    expect(await f.cards()).toEqual([])
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()].length)).toBe(0)
    expect((await (await page.request.get(`/api/library/${f.item.id}`)).json()).usedAt).toBeNull()
    await f.sidebar.screenshot({
      path: test.info().outputPath('placement-read-failure.png'),
      animations: 'disabled',
    })
    f.recover()
    await f.row.click()
    await expect.poll(f.cards).toHaveLength(1)
    await expect(f.sidebar.getByRole('alert')).toHaveCount(0)
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/library/${f.item.id}`)).json()).usedAt ?? 0,
      )
      .toBeGreaterThan(0)
    const [id] = await f.cards()
    expect(
      await page.evaluate((id) => {
        const { doc } = window.__plein.engine
        return [...doc.edges()]
          .filter((edge) => edge.to[0] === id)
          .map((edge) => doc.get(edge.from[0])?.assetId)
      }, id!),
    ).toEqual([f.asset])
  })
}

test('放入后使用记录仍在提交，刷新列表不能丢失最近使用项', async ({ page }) => {
  const f = await fixture(page)
  f.resume()
  let release!: () => void
  let requested!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    requested = resolve
  })
  await page.route(`**/api/library/${f.item.id}/use`, async (route) => {
    requested()
    await gate
    await route.continue()
  })
  try {
    await f.row.click()
    await expect.poll(f.cards).toHaveLength(1)
    await started
    expect((await (await page.request.get(`/api/library/${f.item.id}`)).json()).usedAt).toBeNull()
    const list = page.waitForResponse(
      (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/library',
    )
    await openLibraryPanel(page)
    await list
    const panel = page.getByRole('dialog', { name: '资产库', exact: true })
    await panel
      .getByRole('group', { name: '资产类别', exact: true })
      .getByRole('button', { name: '道具', exact: true })
      .click()
    await panel
      .getByRole('group', { name: '范围', exact: true })
      .getByRole('button', { name: '最近使用', exact: true })
      .click()
    const usedCard = panel.locator(`[data-library-id="${f.item.id}"]`)
    await expect(usedCard).toHaveCount(1)
    const saved = page.waitForResponse(
      (r) => r.url().endsWith(`/api/library/${f.item.id}/use`) && r.status() === 204,
    )
    release()
    await saved
    await page.reload()
    await waitEngine(page)
    await openLibraryPanel(page)
    await panel
      .getByRole('group', { name: '资产类别', exact: true })
      .getByRole('button', { name: '道具', exact: true })
      .click()
    await panel
      .getByRole('group', { name: '范围', exact: true })
      .getByRole('button', { name: '最近使用', exact: true })
      .click()
    await expect(usedCard).toHaveCount(1)
    await expect.poll(f.cards).toHaveLength(1)
  } finally {
    release()
  }
})

for (const entry of ['列表', '编辑档案']) {
  test(`资产库${entry}放入失败在面板内展示错误，重试后带完整参考图关闭面板`, async ({ page }) => {
    const f = await fixture(page, 'http')
    f.resume()
    await f.sidebar.getByRole('button', { name: '打开资产库', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '资产库', exact: true })
    await panel.getByRole('button', { name: '道具', exact: true }).click()
    await panel.getByRole('button', { name: '本项目', exact: true }).click()
    const card = panel.getByRole('listitem').filter({ hasText: f.item.name })
    if (entry === '编辑档案') await card.getByRole('button').first().click()
    else await card.hover()
    const place = panel.getByRole('button', { name: '添加到画布', exact: true })
    await place.click()
    await expect(panel.getByRole('alert')).toContainText('素材服务暂不可用')
    await expect(place).toBeEnabled()
    expect(await f.cards()).toEqual([])
    await panel.screenshot({
      path: test.info().outputPath('library-placement-read-failure.png'),
      animations: 'disabled',
    })
    f.recover()
    await place.click()
    await expect(panel).toBeHidden()
    await expect.poll(f.cards).toHaveLength(1)
    const [id] = await f.cards()
    expect(
      await page.evaluate((id) => {
        const { doc } = window.__plein.engine
        return [...doc.edges()]
          .filter((edge) => edge.to[0] === id)
          .map((edge) => doc.get(edge.from[0])?.assetId)
      }, id!),
    ).toEqual([f.asset])
  })
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
    expect((await (await page.request.get(`/api/library/${f.item.id}`)).json()).usedAt).toBeNull()
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
    await f.row.click()
    await expect.poll(f.cards).toHaveLength(1)
  })
}
