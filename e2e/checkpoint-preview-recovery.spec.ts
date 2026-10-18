import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

const panel = (page: Page) => page.getByRole('dialog', { name: '创作检查点', exact: true })
const article = (page: Page, name: string) =>
  panel(page).getByRole('article').filter({ hasText: name })
async function fixture(page: Page) {
  await newProject(page)
  const canvasId = decodeURIComponent(page.url().split('#/c/')[1]!)
  const canvas = await (await page.request.get(`/api/canvases/${canvasId}`)).json()
  const node = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/text',
      name: '预览原稿',
      x: 0,
      y: 0,
      params: { text: '第一版正文' },
    }),
  )
  await page.getByRole('button', { name: '检查点', exact: true }).click()
  for (const name of ['第一版检查点', '第二版检查点']) {
    if (name === '第二版检查点')
      await page.evaluate((id) => {
        ;(
          window.__plein.engine.doc.mutable(id)!.get('params') as {
            set(key: string, value: string): void
          }
        ).set('text', '第二版正文')
      }, node)
    await panel(page).getByRole('textbox', { name: '检查点名称', exact: true }).fill(name)
    await panel(page).getByRole('button', { name: '保存当前画布', exact: true }).click()
    await expect(article(page, name)).toBeVisible()
    await expect(panel(page).getByRole('button', { name: '关闭预览', exact: true })).toBeVisible()
    await panel(page).getByRole('button', { name: '关闭预览', exact: true }).click()
    await expect(panel(page).getByRole('region', { name: /^预览检查点/ })).toHaveCount(0)
  }
  const list = await (
    await page.request.get(`/api/projects/${canvas.projectId}/checkpoints`)
  ).json()
  return {
    first: list.items.find((item: { name: string }) => item.name === '第一版检查点'),
    second: list.items.find((item: { name: string }) => item.name === '第二版检查点'),
    original: await page.evaluate(() => [...window.__plein.engine.doc.elements()]),
  }
}

test('检查点预览读取失败可直接重试，等待禁用重试，成功预览保持只读', async ({ page }) => {
  const f = await fixture(page)
  let fail = true,
    reads = 0
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/api/checkpoints/${f.first.id}`, async (route) => {
    reads++
    if (fail) return route.fulfill({ status: 503, json: { message: '预览读取暂时失败' } })
    await pending
    await route.continue()
  })
  try {
    await article(page, f.first.name).getByRole('button', { name: '只读预览', exact: true }).click()
    const section = panel(page).getByRole('region', {
      name: `预览检查点 ${f.first.name}`,
      exact: true,
    })
    await expect(section.getByRole('alert')).toContainText('预览读取暂时失败')
    fail = false
    const retry = section.getByRole('button', { name: '重新加载预览', exact: true })
    await retry.click()
    await expect.poll(() => reads).toBe(2)
    await expect(retry).toBeDisabled()
    await expect(section.getByRole('status')).toContainText('正在读取预览')
    release()
    const preview = section.getByTestId('checkpoint-preview')
    await expect(preview).toContainText('第一版正文')
    await preview.locator('canvas').click()
    await page.keyboard.press('Delete')
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
    expect(reads).toBe(2)
  } finally {
    release()
  }
})

for (const state of ['not-valid-base64!%', 'AQ==']) {
  test(`${state === 'AQ==' ? '损坏文档更新' : '损坏编码'}只在检查点预览内报错，重新读取有效快照后可恢复`, async ({
    page,
  }) => {
    const f = await fixture(page)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    let corrupt = true
    await page.route(`**/api/checkpoints/${f.first.id}`, async (route) => {
      const response = await route.fetch()
      await route.fulfill({
        response,
        json: { ...(await response.json()), ...(corrupt ? { state } : {}) },
      })
    })
    await article(page, f.first.name).getByRole('button', { name: '只读预览', exact: true }).click()
    const section = panel(page).getByRole('region', {
      name: `预览检查点 ${f.first.name}`,
      exact: true,
    })
    await expect(section.getByRole('alert')).toContainText('检查点预览数据无法读取')
    await expect(panel(page)).toBeVisible()
    if (state !== 'AQ==') {
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 700 })
        await expect(section.getByRole('alert')).toBeInViewport({ ratio: 1 })
        const retry = section.getByRole('button', { name: '重新加载预览', exact: true })
        await expect(retry).toBeInViewport({ ratio: 1 })
        expect(
          await retry.evaluate((el) => {
            const r = el.getBoundingClientRect()
            return (
              r.x >= 0 &&
              r.right <= innerWidth &&
              el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
            )
          }),
        ).toBe(true)
      }
      await section.screenshot({
        path: test.info().outputPath('checkpoint-preview-error-mobile.png'),
        animations: 'disabled',
      })
      await page.setViewportSize({ width: 1440, height: 900 })
    }
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
    corrupt = false
    await section.getByRole('button', { name: '重新加载预览', exact: true }).click()
    await expect(section.getByTestId('checkpoint-preview')).toContainText('第一版正文')
    await expect(section.getByRole('alert')).toHaveCount(0)
    expect(errors).toEqual([])
  })
}

test('快速切换检查点时迟到的旧预览不覆盖当前版本，原画布保持第二版', async ({ page }) => {
  const f = await fixture(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let received = false,
    settled = false
  await page.route(`**/api/checkpoints/${f.first.id}`, async (route) => {
    const response = await route.fetch()
    received = true
    await pending
    await route.fulfill({ response }).catch(() => {})
    settled = true
  })
  try {
    await article(page, f.first.name).getByRole('button', { name: '只读预览', exact: true }).click()
    await expect.poll(() => received).toBe(true)
    await article(page, f.second.name)
      .getByRole('button', { name: '只读预览', exact: true })
      .click()
    const section = panel(page).getByRole('region', {
      name: `预览检查点 ${f.second.name}`,
      exact: true,
    })
    await expect(section.getByTestId('checkpoint-preview')).toContainText('第二版正文')
    release()
    await expect.poll(() => settled).toBe(true)
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    await expect(section.getByTestId('checkpoint-preview')).toContainText('第二版正文')
    await expect(section.getByTestId('checkpoint-preview')).not.toContainText('第一版正文')
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
  } finally {
    release()
  }
})
