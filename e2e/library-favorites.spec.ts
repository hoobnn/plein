import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

test('收藏等待防止重复提交，失败可见且可重试，收藏筛选与服务端一致', async ({ page }) => {
  await newProject(page)
  const canvas = await (
    await page.request.get(`/api/canvases/${page.url().split('/').at(-1)}`)
  ).json()
  const item = await (
    await page.request.post('/api/library', {
      data: { kind: 'prop', name: '收藏恢复水杯', projectId: canvas.projectId },
    })
  ).json()
  await page.getByRole('button', { name: '资产库', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '资产库', exact: true })
  await panel.getByRole('button', { name: '道具', exact: true }).click()
  await panel.getByRole('button', { name: '本项目', exact: true }).click()
  const card = panel.getByRole('listitem').filter({ hasText: item.name })
  const star = card.getByRole('button', { name: /^(取消收藏|收藏)$/ })
  let resume!: () => void
  const held = new Promise<void>((resolve) => {
    resume = resolve
  })
  let failed = true
  let updates = 0
  await page.route(`**/api/library/${item.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    updates++
    await held
    if (failed)
      return route.fulfill({
        status: 503,
        json: { error: 'test_failure', message: '收藏暂不可用' },
      })
    await route.continue()
  })
  await card.hover()
  await star.dblclick()
  try {
    await expect.poll(() => updates).toBe(1)
    await expect(star).toBeDisabled()
    await expect(star).toHaveAttribute('aria-busy', 'true')
  } finally {
    resume()
  }
  await expect(card.getByRole('alert')).toContainText('收藏暂不可用')
  await expect(star).toBeEnabled()
  await expect(star).toHaveAttribute('aria-pressed', 'false')
  const place = card.getByRole('button', { name: '添加到画布', exact: true })
  const cover = card.locator('[data-lib-cover]')
  const placeBox = (await place.boundingBox())!
  const coverBox = (await cover.boundingBox())!
  expect(placeBox.y + placeBox.height).toBeLessThanOrEqual(coverBox.y + coverBox.height)
  await panel.screenshot({
    path: test.info().outputPath('library-favorite-error.png'),
    animations: 'disabled',
  })
  failed = false
  await star.click()
  await expect(star).toHaveAttribute('aria-pressed', 'true')
  await expect(card.getByRole('alert')).toHaveCount(0)
  const search = panel.getByRole('searchbox', { name: '搜索道具', exact: true })
  await search.fill(' 不匹配的查询 ')
  await expect(card).toHaveCount(0)
  await search.fill(' 收藏恢复 ')
  await expect(card).toBeVisible()
  await search.fill('')
  // 范围按钮位于卡片之前；卡片上也有名为“收藏”的操作。
  await panel.getByRole('button', { name: '收藏', exact: true }).first().click()
  await expect(card).toBeVisible()
  await star.click()
  await expect(card).toHaveCount(0)
  await panel.getByRole('button', { name: '本项目', exact: true }).click()
  await expect(card).toBeVisible()
  await expect(star).toHaveAttribute('aria-pressed', 'false')
  const saved = await (await page.request.get('/api/library')).json()
  expect(saved.find((entry: { id: string }) => entry.id === item.id).favorite).toBe(false)
  expect(updates).toBe(3)
})
