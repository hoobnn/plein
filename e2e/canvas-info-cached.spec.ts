import { expect, type Page, test } from '@playwright/test'
import { clickElement, newProject, zoomTo } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const id = decodeURIComponent(page.url().split('#/c/')[1]!)
  const canvas = await (await page.request.get(`/api/canvases/${id}`)).json()
  await expect(page.getByRole('button', { name: '切换画布', exact: true })).toHaveText(canvas.title)
  return canvas as { id: string; projectId: string; title: string }
}

async function refocus(page: Page) {
  await page.clock.install()
  await page.clock.fastForward(11_000)
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
}

test('已有画布信息刷新失败保留标题和项目操作，明确说明继续使用已加载信息', async ({ page }) => {
  const f = await fixture(page)
  await page.route(`**/api/canvases/${f.id}`, (route) =>
    route.fulfill({ status: 503, json: { message: '最新画布信息暂不可读' } }),
  )
  await refocus(page)
  await page.getByRole('button', { name: '画布信息刷新失败', exact: true }).click()
  const info = page.getByRole('dialog', { name: '画布信息', exact: true })
  await expect(info.getByRole('alert')).toContainText('最新画布信息暂不可读')
  await expect(page.locator('button[aria-label="切换画布"]')).toHaveText(f.title)
  await expect(page.getByRole('button', { name: '检查点', exact: true })).toBeEnabled()
  await expect(info).toContainText('继续使用已加载的信息')
  await info.screenshot({
    path: test.info().outputPath('canvas-info-cached-error.png'),
    animations: 'disabled',
  })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '资产库', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '资产库', exact: true })
  await panel.getByRole('button', { name: '新建角色', exact: true }).first().click()
  await panel.getByRole('button', { name: '基础设定', exact: true }).click()
  await expect(panel.getByRole('checkbox', { name: /^归到当前项目/ })).toBeChecked()
})

test('关闭缓存刷新重试面板后继续编辑，迟到成功更新标题但不抢正文焦点', async ({ page }) => {
  const f = await fixture(page)
  let fail = true,
    reads = 0
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/api/canvases/${f.id}`, async (route) => {
    if (fail) return route.fulfill({ status: 503, json: { message: '缓存刷新失败' } })
    reads++
    await pending
    await route.continue()
  })
  try {
    await refocus(page)
    await page.getByRole('button', { name: '画布信息刷新失败', exact: true }).click()
    const info = page.getByRole('dialog', { name: '画布信息', exact: true })
    expect(
      (
        await page.request.patch(`/api/canvases/${f.id}`, { data: { title: '后台更新的名称' } })
      ).ok(),
    ).toBe(true)
    fail = false
    await info.getByRole('button', { name: '重新加载画布信息', exact: true }).click()
    await expect.poll(() => reads).toBe(1)
    await page.keyboard.press('Escape')
    await expect(info).toHaveCount(0)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/text',
        name: '刷新期间正文',
        x: 0,
        y: 0,
        params: { text: '原始内容' },
      }),
    )
    await zoomTo(page, [id])
    await clickElement(page, id)
    const generator = page.getByTestId('generator')
    if ((await generator.getAttribute('data-compact')) === 'true')
      await generator.getByRole('button', { name: /^编辑/ }).click()
    const prompt = generator.getByRole('textbox', { name: '提示词', exact: true })
    await prompt.fill('继续编辑的正文，不应被元数据打断')
    release()
    await expect(page.getByRole('button', { name: '切换画布', exact: true })).toHaveText(
      '后台更新的名称',
    )
    await expect(prompt).toBeFocused()
    await expect(prompt).toHaveValue('继续编辑的正文，不应被元数据打断')
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([id])
  } finally {
    release()
  }
})

test('刷新中的旧画布信息迟到后不回滚已确认的新名称', async ({ page }) => {
  const f = await fixture(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let snapshotTitle = '',
    settled = false
  await page.route(`**/api/canvases/${f.id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    snapshotTitle = (await response.json()).title
    await pending
    await route.fulfill({ response }).catch(() => {})
    settled = true
  })
  try {
    await refocus(page)
    await expect.poll(() => snapshotTitle).toBe(f.title)
    await page.getByRole('button', { name: '切换画布', exact: true }).click()
    await page
      .getByRole('dialog', { name: '画布', exact: true })
      .getByRole('button', { name: '重命名当前画布', exact: true })
      .click()
    const rename = page.getByRole('dialog', { name: '重命名画布', exact: true })
    await rename.getByRole('textbox').fill('不能被旧信息撤销的新名称')
    await rename.getByRole('button', { name: '保存', exact: true }).click()
    await expect(rename).toHaveCount(0)
    await expect(page.getByRole('button', { name: '切换画布', exact: true })).toHaveText(
      '不能被旧信息撤销的新名称',
    )
    release()
    await expect.poll(() => settled).toBe(true)
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    await expect(page.getByRole('button', { name: '切换画布', exact: true })).toHaveText(
      '不能被旧信息撤销的新名称',
    )
    expect((await (await page.request.get(`/api/canvases/${f.id}`)).json()).title).toBe(
      '不能被旧信息撤销的新名称',
    )
  } finally {
    release()
  }
})
