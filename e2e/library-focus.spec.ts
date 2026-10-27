import { openLibraryPanel } from './library-ui'
import { expect, type Page, test } from './fixtures'
import { newProject, waitEngine } from './canvas'

test('320px 下资产类别可用键盘逐项访问，导航不撑出面板', async ({ page }) => {
  await newProject(page)
  await page.setViewportSize({ width: 320, height: 700 })
  await openLibraryPanel(page)
  const panel = page.getByRole('dialog', { name: '资产库', exact: true })
  const categories = panel.getByRole('group', { name: '资产类别', exact: true })
  const buttons = categories.getByRole('button')
  await expect(buttons).toHaveCount(6)
  await buttons.first().focus()
  for (let i = 0; i < 6; i++) {
    const button = buttons.nth(i)
    if (i > 0) await page.keyboard.press('Tab')
    await expect(button).toBeFocused()
    await expect(button).toBeInViewport({ ratio: 1 })
    await page.keyboard.press('Enter')
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(panel.getByRole('button', { name: '关闭', exact: true })).toBeInViewport()
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  }
  await expect(categories.getByRole('button', { name: '音色', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await panel.screenshot({ path: test.info().outputPath('library-categories-320.png') })
})

async function fixture(page: Page, count = 2, cold = false) {
  if (cold) {
    const response = await page.request.post('/api/projects', {
      data: { title: '画布直达加载验证' },
    })
    expect(response.ok()).toBe(true)
    const project = await response.json()
    await page.goto(`/#/c/${project.lastCanvasId}`)
    await waitEngine(page)
  } else await newProject(page)
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
  await openLibraryPanel(page)
  const panel = page.getByRole('dialog', { name: '资产库', exact: true })
  await panel.getByRole('button', { name: '道具', exact: true }).click()
  await panel.getByRole('button', { name: '本项目', exact: true }).click()
  const search = panel.getByRole('searchbox', { name: '搜索道具', exact: true })
  await search.fill(`${prefix} 焦点测试`)
  await expect(panel.getByRole('listitem')).toHaveCount(count)
  return { panel, search, prefix }
}

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

for (const profile of [false, true]) {
  test(`资产库${profile ? '档案' : '列表'}叠加设置，Esc 只关闭设置并恢复原焦点`, async ({
    page,
  }) => {
    const { panel, search, prefix } = await fixture(page)
    let control = search
    if (profile) {
      await panel
        .getByRole('listitem')
        .filter({ hasText: '焦点测试一' })
        .getByRole('button')
        .first()
        .click()
      control = panel.getByRole('textbox', { name: '名称', exact: true })
      await expect(control).toHaveValue(`${prefix} 焦点测试一`)
    }
    await control.focus()
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('plein:open-settings')))
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await expect(settings).toBeVisible()
    await settings.getByRole('button', { name: '关闭', exact: true }).focus()
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
    await expect(panel).toBeVisible()
    await expect(control).toBeFocused()
    await expect(control).toHaveValue(profile ? `${prefix} 焦点测试一` : `${prefix} 焦点测试`)
    if (!profile) await expect(panel.getByRole('listitem')).toHaveCount(2)
  })
}

test('首次设置代码加载等待不隐藏资产库，仍能搜索并在关闭设置后继续编辑', async ({ page }) => {
  const { panel, search, prefix } = await fixture(page, 2, true)
  let release!: () => void
  let entered = false
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(/\/Settings(?:-[^/]+)?\.(?:tsx|js)(?:\?.*)?$/, async (route) => {
    entered = true
    await gate
    await route.continue()
  })
  try {
    await search.focus()
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('plein:open-settings')))
    await expect.poll(() => entered).toBe(true)
    await expect(panel).toBeVisible()
    await expect(search).toBeFocused()
    await search.fill(`${prefix} 焦点测试一`)
    await expect(panel.getByRole('listitem')).toHaveCount(1)
    release()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await expect(settings).toBeVisible()
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(settings).toHaveCount(0)
    await expect(search).toHaveValue(`${prefix} 焦点测试一`)
    await expect(search).toBeFocused()
    await expect(panel.getByRole('listitem')).toHaveCount(1)
  } finally {
    release()
  }
})
