import { expect, test } from '@playwright/test'
import { newProject, waitEngine } from './canvas'

test('角色存档与档案入口并发只建档一次，离开角色后不打开迟到档案', async ({ page }) => {
  await newProject(page)
  const [role, other] = await page.evaluate(() => {
    const role = window.__plein.addNode({
      type: 'plein/character',
      name: '并发存档角色',
      params: { description: '角色设定' },
      x: 900,
      y: 500,
    })
    const other = window.__plein.addNode({
      type: 'plein/prop',
      name: '另一个道具',
      params: {},
      x: 1400,
      y: 500,
    })
    window.__plein.engine.selection.set([role])
    return [role, other]
  })
  let finish!: () => void
  const held = new Promise<void>((resolve) => {
    finish = resolve
  })
  let requests = 0
  await page.route('**/api/library/save-card', async (route) => {
    requests++
    await held
    await route.continue()
  })
  const generator = page.getByTestId('generator')
  try {
    await generator.getByRole('button', { name: '存入资产库', exact: true }).click()
    await expect.poll(() => requests).toBe(1)
    await expect(generator.getByRole('button', { name: '保存中…' })).toBeDisabled()
    await generator.getByRole('button', { name: '添加时期、服饰、表情' }).click()
    await expect(generator.getByRole('button', { name: '打开中…' })).toBeDisabled()
    expect(requests).toBe(1)
    await page.evaluate((id) => window.__plein.engine.selection.set([id!]), other)
    await expect(generator.locator('input').first()).toHaveValue('另一个道具')
  } finally {
    finish()
  }
  await page.waitForLoadState('networkidle')
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id!)?.params?.libraryId, role))
    .toBeTruthy()
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id!)?.params?.libraryId, other),
  ).toBeUndefined()
  expect(await page.getByRole('dialog', { name: '资产库' }).count()).toBe(0)
  expect(await page.locator('.ui-toast').filter({ hasText: '并发存档角色' }).count()).toBe(0)
  const items = await (await page.request.get('/api/library')).json()
  expect(items.filter((item: { name: string }) => item.name === '并发存档角色')).toHaveLength(1)
})

test('存档503后可重试，成功后更新同条目，来源设定和关联不丢失', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() => {
    const id = window.__plein.addNode({
      type: 'plein/prop',
      name: '可恢复存档水杯',
      params: { description: '完整设定' },
      x: 900,
      y: 500,
    })
    window.__plein.engine.selection.set([id])
    return id
  })
  await page.route(
    '**/api/library/save-card',
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'unavailable', message: '存档暂不可用' }),
      }),
    { times: 1 },
  )
  const generator = page.getByTestId('generator')
  const save = generator.getByRole('button', { name: '存入资产库', exact: true })
  await save.click()
  await expect(page.locator('.ui-toast')).toContainText('存档暂不可用')
  await expect(save).toBeEnabled()
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params, id)).toMatchObject({
    description: '完整设定',
  })
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.libraryId, id),
  ).toBeUndefined()
  await save.click()
  await expect(generator.getByRole('button', { name: '更新资产库', exact: true })).toBeEnabled()
  const libraryId = await page.evaluate(
    (id) => window.__plein.engine.doc.get(id)?.params?.libraryId,
    id,
  )
  await generator.getByRole('button', { name: '更新资产库', exact: true }).click()
  await expect(page.locator('.ui-toast')).toContainText('已更新资产库里的道具')
  const items = await (await page.request.get('/api/library')).json()
  expect(items.filter((item: { name: string }) => item.name === '可恢复存档水杯')).toEqual([
    expect.objectContaining({ id: libraryId, description: '完整设定' }),
  ])
})

test('存档等待时切换画布，来源关联在服务端完成且迟到结果不改旧文档或通知新画布', async ({
  page,
}) => {
  await newProject(page)
  const original = page.url()
  const canvas = await (
    await page.request.get(`/api/canvases/${original.split('/').at(-1)}`)
  ).json()
  const id = await page.evaluate(() => {
    const id = window.__plein.addNode({
      type: 'plein/prop',
      name: '跨画布存档水杯',
      params: { description: '来源设定' },
      x: 900,
      y: 500,
    })
    window.__plein.engine.selection.set([id])
    const engine = window.__plein.engine
    ;(window as unknown as { oldLibraryId(): unknown }).oldLibraryId = () =>
      engine.doc.get(id)?.params?.libraryId
    ;(window as unknown as { oldSaveEngine(): boolean }).oldSaveEngine = () =>
      window.__plein?.engine === engine
    return id
  })
  const generator = page.getByTestId('generator')
  await expect(generator.getByRole('button', { name: '存入资产库', exact: true })).toBeVisible()
  const next = await (
    await page.request.post('/api/projects', { data: { title: '存档期间的新画布' } })
  ).json()
  let resume!: () => void
  const held = new Promise<void>((resolve) => {
    resume = resolve
  })
  let requested = false
  const hold = async (route: import('@playwright/test').Route) => {
    if (route.request().method() !== 'POST') return route.continue()
    requested = true
    await held
    await route.continue()
  }
  await page.route('**/api/library', hold)
  await page.route('**/api/library/save-card', hold)
  try {
    await generator.getByRole('button', { name: '存入资产库', exact: true }).click()
    await expect.poll(() => requested).toBe(true)
    await page.evaluate((id) => {
      location.hash = `#/c/${id}`
    }, next.lastCanvasId)
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { oldSaveEngine(): boolean }).oldSaveEngine()),
      )
      .toBe(false)
    await waitEngine(page)
  } finally {
    resume()
  }
  await page.waitForLoadState('networkidle')
  expect(
    await page.evaluate(() => (window as unknown as { oldLibraryId(): unknown }).oldLibraryId()),
  ).toBeUndefined()
  expect(await page.locator('.ui-toast').filter({ hasText: '跨画布存档水杯' }).count()).toBe(0)
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()].length)).toBe(0)
  await page.evaluate((url) => {
    location.hash = new URL(url).hash
  }, original)
  await waitEngine(page)
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.libraryId, id))
    .toBeTruthy()
  const items = (await (await page.request.get('/api/library')).json()).filter(
    (entry: { projectId: string }) => entry.projectId === canvas.projectId,
  )
  expect(items).toHaveLength(1)
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.libraryId, id),
  ).toBe(items[0].id)
})
