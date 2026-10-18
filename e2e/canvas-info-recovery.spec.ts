import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const id = decodeURIComponent(page.url().split('#/c/')[1]!)
  return (await (await page.request.get(`/api/canvases/${id}`)).json()) as {
    id: string
    projectId: string
    title: string
  }
}

test('首次读取画布信息等待有说明，画布保持可用，完成后恢复项目操作', async ({ page }) => {
  const f = await fixture(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/api/canvases/${f.id}`, async (route) => {
    await pending
    await route.continue()
  })
  try {
    await page.reload()
    await expect(page.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected')
    await expect(page.getByRole('button', { name: '画布信息正在加载', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '检查点', exact: true })).toBeDisabled()
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/text',
        name: '元数据等待期间的编辑',
        x: 0,
        y: 0,
        params: { text: '不因读取信息而丢失' },
      }),
    )
    release()
    await expect(page.getByRole('button', { name: '切换画布', exact: true })).toHaveText(f.title)
    await expect(page.getByRole('button', { name: '检查点', exact: true })).toBeEnabled()
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, id)).toBe(
      '不因读取信息而丢失',
    )
  } finally {
    release()
  }
})

test('画布信息读取失败可原地重试，保留等待提示，恢复后角色默认归属正确项目', async ({ page }) => {
  const f = await fixture(page)
  let fail = true,
    retries = 0
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/api/canvases/${f.id}`, async (route) => {
    if (fail) return route.fulfill({ status: 503, json: { message: '画布信息暂时不可用' } })
    retries++
    await pending
    await route.continue()
  })
  try {
    await page.reload()
    await expect(page.getByTestId('sync-status')).toHaveAttribute('data-sync', 'connected')
    await page.getByRole('button', { name: '画布信息加载失败', exact: true }).click()
    const info = page.getByRole('dialog', { name: '画布信息', exact: true })
    await expect(info.getByRole('alert')).toContainText('画布信息暂时不可用')
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 700 })
      await expect(
        info.getByRole('button', { name: '重新加载画布信息', exact: true }),
      ).toBeInViewport()
      expect(
        await info.evaluate((el) => {
          const r = el.getBoundingClientRect()
          return r.x >= 0 && r.right <= innerWidth
        }),
      ).toBe(true)
    }
    await info.screenshot({
      path: test.info().outputPath('canvas-info-error.png'),
      animations: 'disabled',
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    const before = await page.evaluate(() => [...window.__plein.engine.doc.elements()])
    fail = false
    const retry = info.getByRole('button', { name: '重新加载画布信息', exact: true })
    await retry.click()
    await expect.poll(() => retries).toBe(1)
    await expect(retry).toBeDisabled()
    release()
    await expect(info).toHaveCount(0)
    await expect(page.getByRole('button', { name: '切换画布', exact: true })).toHaveText(f.title)
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(before)
    await expect(page.getByRole('button', { name: '切换画布', exact: true })).toBeFocused()
    await page.getByRole('button', { name: '资产库', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '资产库', exact: true })
    await panel.getByRole('button', { name: '新建角色', exact: true }).first().click()
    await panel.getByRole('textbox', { name: '名称', exact: true }).fill('信息恢复后的角色')
    await panel.getByRole('button', { name: '基础设定', exact: true }).click()
    await expect(panel.getByRole('checkbox', { name: /^归到当前项目/ })).toBeChecked()
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
    const items = await (await page.request.get('/api/library')).json()
    expect(items.find((item: { name: string }) => item.name === '信息恢复后的角色').projectId).toBe(
      f.projectId,
    )
    expect(retries).toBe(1)
  } finally {
    release()
  }
})

for (const outcome of ['success', 'failure'] as const) {
  test(`画布信息重试期间切到其他项目，迟到${outcome === 'success' ? '成功' : '失败'}不混淆当前项目`, async ({
    page,
  }) => {
    const f = await fixture(page)
    const other = await (
      await page.request.post('/api/projects', { data: { title: '不接收旧元数据的项目' } })
    ).json()
    let fail = true,
      received = 0
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(`**/api/canvases/${f.id}`, async (route) => {
      if (fail) return route.fulfill({ status: 503, json: { message: '原画布信息未读取' } })
      received++
      await pending
      if (outcome === 'failure')
        return route.fulfill({ status: 503, json: { message: '旧项目的迟到失败' } })
      await route.continue()
    })
    try {
      await page.reload()
      await page.getByRole('button', { name: '画布信息加载失败', exact: true }).click()
      const info = page.getByRole('dialog', { name: '画布信息', exact: true })
      fail = false
      await info.getByRole('button', { name: '重新加载画布信息', exact: true }).click()
      await expect.poll(() => received).toBe(1)
      await page.keyboard.press('Escape')
      await expect(info).toHaveCount(0)
      await page.getByRole('link', { name: 'Plein', exact: true }).click()
      await page
        .locator(`[data-project="${other.id}"]`)
        .getByRole('link', { name: other.title, exact: true })
        .click()
      await expect(page).toHaveURL(new RegExp(`#/c/${other.lastCanvasId}$`))
      await expect(page.getByRole('button', { name: other.title, exact: true })).toBeVisible()
      const completed = page
        .waitForResponse((response) => response.url().endsWith(`/api/canvases/${f.id}`))
        .then((response) => response.finished())
      release()
      await completed
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      await expect(page.getByRole('button', { name: other.title, exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '画布信息加载失败', exact: true })).toHaveCount(
        0,
      )
      expect(page.url()).toContain(`#/c/${other.lastCanvasId}`)
    } finally {
      release()
    }
  })
}
