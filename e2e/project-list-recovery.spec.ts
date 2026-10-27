import { expect, test } from './fixtures'
import { newProject } from './canvas'

for (const operation of ['rename', 'delete'] as const) {
  test(`${operation === 'rename' ? '改名' : '删除'}已成功但列表刷新失败时保留已确认结果，重试列表不重复写入`, async ({
    page,
  }) => {
    await newProject(page, { visitHome: true })
    const canvasId = decodeURIComponent(page.url().split('#/c/')[1]!)
    const canvas = await (await page.request.get(`/api/canvases/${canvasId}`)).json()
    const projectId = canvas.projectId as string
    let failList = false,
      writes = 0
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      if (failList) return route.fulfill({ status: 503, json: { message: '项目列表暂时不可用' } })
      const response = await route.fetch()
      const items = await response.json()
      // 公共本地图标充当封面，验证改名应答不带 covers 时保留列表专用展示数据。
      await route.fulfill({
        response,
        json: items.map((item: { id: string }) =>
          item.id === projectId ? { ...item, covers: ['/plein-icon.png'] } : item,
        ),
      })
    })
    await page.goto('/')
    const card = page.locator(`[data-project="${projectId}"]`)
    await expect(card).toBeVisible()
    const image = card.locator('.home-cover img')
    await expect(image).toHaveCount(1)
    await expect
      .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0)
    page.on('request', (request) => {
      if (
        request.url().endsWith(`/api/projects/${projectId}`) &&
        ['PATCH', 'DELETE'].includes(request.method())
      )
        writes++
    })
    failList = true
    if (operation === 'rename') {
      await card.getByRole('button', { name: '重命名', exact: true }).click()
      await card.getByRole('textbox', { name: '项目名称', exact: true }).fill('已经保存的新名称')
      await page.keyboard.press('Enter')
      await expect(card.getByRole('link', { name: '已经保存的新名称', exact: true })).toBeVisible()
      expect((await (await page.request.get(`/api/projects/${projectId}`)).json()).title).toBe(
        '已经保存的新名称',
      )
      await expect(image).toHaveCount(1)
    } else {
      await card.getByRole('button', { name: '删除', exact: true }).click()
      await page
        .getByRole('dialog', { name: /^删除项目/ })
        .getByRole('button', { name: '删除', exact: true })
        .click()
      await expect(card).toHaveCount(0)
      expect((await page.request.get(`/api/projects/${projectId}`)).status()).toBe(404)
    }
    const error = page.getByRole('alert').filter({ hasText: '项目列表刷新失败' })
    await expect(error).toContainText('项目列表暂时不可用')
    if (operation === 'rename') {
      await page.setViewportSize({ width: 390, height: 700 })
      await page.mouse.move(380, 650)
      await page.mouse.wheel(0, Math.max(0, (await error.boundingBox())!.y - 90))
      await expect(
        error.getByRole('button', { name: '重新加载项目', exact: true }),
      ).toBeInViewport()
      await expect(
        card.getByRole('link', { name: '已经保存的新名称', exact: true }),
      ).toBeInViewport()
      await page.screenshot({
        path: test.info().outputPath('project-list-refresh-error.png'),
        animations: 'disabled',
      })
    }
    failList = false
    await error.getByRole('button', { name: '重新加载项目', exact: true }).click()
    await expect(error).toHaveCount(0)
    if (operation === 'rename') {
      await expect(card.getByRole('link', { name: '已经保存的新名称', exact: true })).toBeVisible()
      await expect(image).toHaveAttribute('src', '/plein-icon.png')
    } else await expect(card).toHaveCount(0)
    expect(writes).toBe(1)
  })
}

for (const width of [320]) {
  test(`${width}px 首页顶部素材、资产库、主题与设置完整可操作`, async ({ page }) => {
    await newProject(page)
    await page.goto('/')
    await page.setViewportSize({ width, height: 700 })
    const header = page.getByRole('banner')
    for (const name of ['素材', '资产库', '跟随系统', '浅色', '深色', '设置']) {
      const button = header.getByRole('button', { name, exact: true })
      await expect(button).toBeVisible()
      expect(
        await button.evaluate((el) => {
          const r = el.getBoundingClientRect()
          return (
            r.x >= 0 &&
            r.right <= innerWidth &&
            el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
          )
        }),
      ).toBe(true)
    }
    for (const name of ['浅色', '深色', '跟随系统']) {
      const theme = header.getByRole('button', { name, exact: true })
      await theme.click()
      await expect(theme).toHaveAttribute('aria-pressed', 'true')
    }
    await header.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible()
  })
}

test('首次加载项目失败可在当前页面重试，等待期间禁用重试按钮', async ({ page }) => {
  await newProject(page)
  let fail = true
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let retries = 0
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    if (fail) return route.fulfill({ status: 503, json: { message: '首次项目加载失败' } })
    retries++
    await pending
    await route.continue()
  })
  try {
    await page.goto('/')
    const error = page.getByRole('alert').filter({ hasText: '项目列表加载失败' })
    await expect(error).toContainText('首次项目加载失败')
    const retry = error.getByRole('button', { name: '重新加载项目', exact: true })
    fail = false
    await retry.click()
    await expect.poll(() => retries).toBe(1)
    await expect(retry).toBeDisabled()
    release()
    await expect(error).toHaveCount(0)
    await expect(page.locator('[data-project]').first()).toBeVisible()
    expect(retries).toBe(1)
  } finally {
    release()
  }
})

test('画布页改名后返回首页，列表刷新失败也显示已保存的项目名', async ({ page }) => {
  await newProject(page, { visitHome: true })
  const canvasId = decodeURIComponent(page.url().split('#/c/')[1]!)
  const canvas = await (await page.request.get(`/api/canvases/${canvasId}`)).json()
  let writes = 0
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().endsWith(`/api/projects/${canvas.projectId}`))
      writes++
  })
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 503, json: { message: '返回首页时刷新失败' } })
      : route.continue(),
  )
  await page.getByTitle('重命名项目').click()
  await page.getByRole('textbox', { name: '项目名称', exact: true }).fill('画布页已保存的名称')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '画布页已保存的名称', exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Plein', exact: true }).click()
  const card = page.locator(`[data-project="${canvas.projectId}"]`)
  await expect(card.getByRole('link', { name: '画布页已保存的名称', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('项目列表刷新失败')
  expect(writes).toBe(1)
})

for (const operation of ['rename', 'delete'] as const) {
  test(`${operation === 'rename' ? '改名' : '删除'}期间迟到的旧列表不能恢复旧项目数据`, async ({
    page,
  }) => {
    await newProject(page, { visitHome: true })
    const canvasId = decodeURIComponent(page.url().split('#/c/')[1]!)
    const canvas = await (await page.request.get(`/api/canvases/${canvasId}`)).json()
    const snapshot = await (await page.request.get('/api/projects')).json()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let reads = 0,
      settled = false
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      reads++
      if (reads !== 1) return route.continue()
      await pending
      // 旧请求可能已被查询层取消；无论迟到结果被丢弃还是送达，都不能覆盖确认写入。
      await route.fulfill({ json: snapshot }).catch(() => {})
      settled = true
    })
    try {
      await page.getByRole('link', { name: 'Plein', exact: true }).click()
      const card = page.locator(`[data-project="${canvas.projectId}"]`)
      await expect(card).toBeVisible()
      await expect.poll(() => reads).toBe(1)
      if (operation === 'rename') {
        await card.getByRole('button', { name: '重命名', exact: true }).click()
        await card
          .getByRole('textbox', { name: '项目名称', exact: true })
          .fill('不能被旧列表撤销的名称')
        await page.keyboard.press('Enter')
        await expect(
          card.getByRole('link', { name: '不能被旧列表撤销的名称', exact: true }),
        ).toBeVisible()
      } else {
        await card.getByRole('button', { name: '删除', exact: true }).click()
        await page
          .getByRole('dialog', { name: /^删除项目/ })
          .getByRole('button', { name: '删除', exact: true })
          .click()
        await expect(card).toHaveCount(0)
      }
      await expect.poll(() => reads).toBeGreaterThan(1)
      release()
      await expect.poll(() => settled).toBe(true)
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      if (operation === 'rename')
        await expect(
          card.getByRole('link', { name: '不能被旧列表撤销的名称', exact: true }),
        ).toBeVisible()
      else await expect(card).toHaveCount(0)
    } finally {
      release()
    }
  })
}
