import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

async function fixture(page: Page, count = 2) {
  await newProject(page)
  const canvas = await (
    await page.request.get(`/api/canvases/${page.url().split('/').at(-1)}`)
  ).json()
  const prefix = canvas.id as string
  const names = Array.from(
    { length: count },
    (_, index) => ['焦点测试一', '焦点测试二'][index] ?? `焦点测试${index}`,
  )
  for (const name of names) {
    const created = await page.request.post('/api/library', {
      data: { kind: 'prop', name: `${prefix} ${name}`, projectId: canvas.projectId },
    })
    const item = await created.json()
    await page.request.patch(`/api/library/${item.id}`, { data: { favorite: true } })
  }
  await page.getByRole('button', { name: '资产库', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '资产库', exact: true })
  await panel.getByRole('button', { name: '道具', exact: true }).click()
  await panel.getByRole('button', { name: '本项目', exact: true }).click()
  const search = panel.getByRole('searchbox', { name: '搜索道具', exact: true })
  await search.fill(`${prefix} 焦点测试`)
  await expect(panel.getByRole('listitem')).toHaveCount(count)
  return { panel, search, prefix }
}

test('键盘从编辑返回列表，焦点回到原资产卡片', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 560 })
  const { panel, prefix } = await fixture(page)
  const card = panel.getByRole('listitem').filter({ hasText: '焦点测试一' })
  const open = card.getByRole('button').first()
  await open.focus()
  await page.keyboard.press('Enter')
  await expect(panel.getByRole('textbox', { name: '名称', exact: true })).toHaveValue(
    `${prefix} 焦点测试一`,
  )
  await panel.getByRole('button', { name: '返回', exact: true }).focus()
  await expect(panel.getByRole('button', { name: '返回', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(open).toBeFocused()
  await expect(card).toHaveCSS('outline-style', 'solid')
  await panel.screenshot({
    path: test.info().outputPath('library-return-focus.png'),
    animations: 'disabled',
  })
})

test('长列表返回原卡片时同时恢复焦点和可见位置', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 560 })
  const { panel } = await fixture(page, 18)
  const card = panel.getByRole('listitem').last()
  const open = card.getByRole('button').first()
  await open.focus()
  await page.keyboard.press('Enter')
  await expect(panel.getByRole('textbox', { name: '名称', exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '返回', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(open).toBeFocused()
  await expect(open).toBeInViewport()
})

test('改名使原搜索结果消失时，返回后聚焦查询框继续搜索', async ({ page }) => {
  const { panel, search, prefix } = await fixture(page)
  await search.fill(`${prefix} 焦点测试一`)
  await panel.getByRole('listitem').getByRole('button').first().click()
  await panel.getByRole('textbox', { name: '名称', exact: true }).fill(`${prefix} 新的查询名称`)
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  await panel.getByRole('button', { name: '返回', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(search).toBeFocused()
  await expect(search).toHaveValue(`${prefix} 焦点测试一`)
  await search.fill(`${prefix} 新的查询名称`)
  await expect(panel.getByRole('listitem')).toHaveCount(1)
})

test('取消收藏等待期间主动搜索，迟到响应不夺走查询框焦点', async ({ page }) => {
  const { panel, search, prefix } = await fixture(page)
  await panel.getByRole('button', { name: '收藏', exact: true }).first().click()
  let resume!: () => void
  const held = new Promise<void>((resolve) => {
    resume = resolve
  })
  await page.route('**/api/library/*', async (route) => {
    if (route.request().method() === 'PATCH') await held
    await route.continue()
  })
  const star = panel
    .getByRole('listitem')
    .filter({ hasText: '焦点测试一' })
    .getByRole('button', { name: '取消收藏', exact: true })
  try {
    await star.focus()
    await page.keyboard.press('Space')
    await expect(star).toBeDisabled()
    await search.focus()
    await search.fill(`${prefix} 焦点测试二`)
  } finally {
    resume()
  }
  await page.waitForLoadState('networkidle')
  await expect(search).toBeFocused()
  await expect(panel.getByRole('listitem')).toHaveCount(1)
})

test('收藏列表取消当前卡片后聚焦下一项，最后一项消失后聚焦查询框', async ({ page }) => {
  const { panel, search } = await fixture(page)
  await panel.getByRole('button', { name: '收藏', exact: true }).first().click()
  const first = panel.getByRole('listitem').filter({ hasText: '焦点测试一' })
  await first.getByRole('button', { name: '取消收藏', exact: true }).focus()
  await page.keyboard.press('Space')
  await expect(first).toHaveCount(0)
  const remaining = panel.getByRole('listitem')
  await expect(remaining.getByRole('button').first()).toBeFocused()
  await remaining.getByRole('button', { name: '取消收藏', exact: true }).focus()
  await page.keyboard.press('Space')
  await expect(remaining).toHaveCount(0)
  await expect(search).toBeFocused()
})
