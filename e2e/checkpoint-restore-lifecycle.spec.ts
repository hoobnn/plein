import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

const panel = (page: Page) => page.getByRole('dialog', { name: '创作检查点', exact: true })
const name = '待恢复的检查点'
async function fixture(page: Page) {
  await newProject(page)
  const canvasId = decodeURIComponent(page.url().split('#/c/')[1]!)
  const canvas = await (await page.request.get(`/api/canvases/${canvasId}`)).json()
  const other = await (
    await page.request.post('/api/projects', { data: { title: '检查点异步操作的目标项目' } })
  ).json()
  await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/text',
      name: '检查点原稿',
      x: 0,
      y: 0,
      params: { text: '恢复必须保留的原稿' },
    }),
  )
  await page.getByRole('button', { name: '检查点', exact: true }).click()
  await panel(page).getByRole('textbox', { name: '检查点名称', exact: true }).fill(name)
  await panel(page).getByRole('button', { name: '保存当前画布', exact: true }).click()
  await expect(panel(page).getByRole('article').filter({ hasText: name })).toBeVisible()
  const list = await (
    await page.request.get(`/api/projects/${canvas.projectId}/checkpoints`)
  ).json()
  return {
    canvas,
    checkpoint: list.items.find((item: { name: string }) => item.name === name),
    other,
  }
}

for (const outcome of ['success', 'failure'] as const) {
  test(`关闭检查点窗口并切到其他项目后，迟到恢复${outcome === 'success' ? '成功' : '失败'}不关闭新窗口或接管导航`, async ({
    page,
  }) => {
    const f = await fixture(page)
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let writes = 0
    let restoredId = ''
    const path = `/api/checkpoints/${f.checkpoint.id}/restore`
    await page.route(`**${path}`, async (route) => {
      writes++
      await pending
      if (outcome === 'failure')
        return route.fulfill({ status: 503, json: { message: '原项目恢复暂时失败' } })
      const response = await route.fetch()
      restoredId = (await response.json()).canvasId
      await route.fulfill({ response })
    })
    try {
      await panel(page)
        .getByRole('article')
        .filter({ hasText: name })
        .getByRole('button', { name: '恢复为新画布', exact: true })
        .click()
      await expect.poll(() => writes).toBe(1)
      await panel(page).getByRole('button', { name: '关闭', exact: true }).click()
      await expect(panel(page)).toHaveCount(0)
      await page.getByRole('link', { name: 'Plein', exact: true }).click()
      await page
        .locator(`[data-project="${f.other.id}"]`)
        .getByRole('link', { name: f.other.title, exact: true })
        .click()
      await expect(page.getByRole('button', { name: f.other.title, exact: true })).toBeVisible()
      await page.getByRole('button', { name: '检查点', exact: true }).click()
      await expect(panel(page)).toBeVisible()
      const before = await page.evaluate(() => [...window.__plein.engine.doc.elements()])
      const completed = page
        .waitForResponse((response) => response.url().endsWith(path))
        .then((response) => response.finished())
      release()
      await completed
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      await expect(panel(page)).toBeVisible()
      await expect(page).toHaveURL(new RegExp(`#/c/${f.other.lastCanvasId}$`))
      await expect(panel(page).getByRole('alert')).toHaveCount(0)
      expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(before)
      if (outcome === 'success') {
        expect(restoredId).not.toBe('')
        const created = await (await page.request.get(`/api/canvases/${restoredId}`)).json()
        expect(created.projectId).toBe(f.canvas.projectId)
      }
      expect(writes).toBe(1)
    } finally {
      release()
    }
  })
}

test('恢复检查点等待有明确反馈，原窗口关闭后仍只创建一张新画布', async ({ page }) => {
  const f = await fixture(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let writes = 0
  const path = `/api/checkpoints/${f.checkpoint.id}/restore`
  await page.route(`**${path}`, async (route) => {
    writes++
    await pending
    await route.continue()
  })
  try {
    await panel(page)
      .getByRole('article')
      .filter({ hasText: name })
      .getByRole('button', { name: '恢复为新画布', exact: true })
      .click()
    await expect.poll(() => writes).toBe(1)
    await expect(
      panel(page).getByRole('status').filter({ hasText: '正在恢复为新画布' }),
    ).toBeVisible()
    await expect(panel(page).getByRole('button', { name: '恢复中…', exact: true })).toBeDisabled()
    await panel(page).screenshot({
      path: test.info().outputPath('checkpoint-restoring.png'),
      animations: 'disabled',
    })
    const completed = page
      .waitForResponse((response) => response.url().endsWith(path))
      .then((response) => response.finished())
    await panel(page).getByRole('button', { name: '关闭', exact: true }).click()
    await expect(panel(page)).toHaveCount(0)
    release()
    await completed
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    await expect(page).toHaveURL(new RegExp(`#/c/${f.canvas.id}$`))
    const canvases = await (
      await page.request.get(`/api/projects/${f.canvas.projectId}/canvases`)
    ).json()
    expect(canvases).toHaveLength(2)
    expect(writes).toBe(1)
  } finally {
    release()
  }
})

test('关闭后重开同一画布的检查点窗口，旧恢复成功不会关闭本次窗口', async ({ page }) => {
  const f = await fixture(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let received = 0
  const path = `/api/checkpoints/${f.checkpoint.id}/restore`
  await page.route(`**${path}`, async (route) => {
    received++
    await pending
    await route.continue()
  })
  try {
    await panel(page)
      .getByRole('article')
      .filter({ hasText: name })
      .getByRole('button', { name: '恢复为新画布', exact: true })
      .click()
    await expect.poll(() => received).toBe(1)
    await panel(page).getByRole('button', { name: '关闭', exact: true }).click()
    await expect(panel(page)).toHaveCount(0)
    await page.getByRole('button', { name: '检查点', exact: true }).click()
    await expect(panel(page).getByRole('article').filter({ hasText: name })).toBeVisible()
    const completed = page
      .waitForResponse((response) => response.url().endsWith(path))
      .then((response) => response.finished())
    release()
    await completed
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    await expect(panel(page)).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`#/c/${f.canvas.id}$`))
    expect(received).toBe(1)
  } finally {
    release()
  }
})

test(
  '当前窗口恢复失败保留检查点并可重试，成功后只创建一个副本且原画布保留',
  { tag: '@core' },
  async ({ page }) => {
    const f = await fixture(page)
    let writes = 0
    await page.route(`**/api/checkpoints/${f.checkpoint.id}/restore`, (route) => {
      writes++
      return writes === 1
        ? route.fulfill({ status: 503, json: { message: '恢复服务暂时不可用' } })
        : route.continue()
    })
    const article = panel(page).getByRole('article').filter({ hasText: name })
    await article.getByRole('button', { name: '恢复为新画布', exact: true }).click()
    await expect(panel(page).getByRole('alert')).toContainText('恢复服务暂时不可用')
    await expect(article.getByRole('button', { name: '恢复为新画布', exact: true })).toBeEnabled()
    await article.getByRole('button', { name: '恢复为新画布', exact: true }).click()
    await expect(panel(page)).toHaveCount(0)
    await expect(page).not.toHaveURL(new RegExp(`#/c/${f.canvas.id}$`))
    const id = decodeURIComponent(page.url().split('#/c/')[1]!)
    expect((await (await page.request.get(`/api/canvases/${id}`)).json()).projectId).toBe(
      f.canvas.projectId,
    )
    expect((await page.request.get(`/api/canvases/${f.canvas.id}`)).ok()).toBe(true)
    expect(
      await (await page.request.get(`/api/projects/${f.canvas.projectId}/canvases`)).json(),
    ).toHaveLength(2)
    expect(writes).toBe(2)
  },
)
