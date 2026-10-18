import { expect, test } from '@playwright/test'
import { byName, newProject, waitEngine } from './canvas'

const mock = '/api/providers/plein/mock/config'

test('引导创建期间切换页面再返回，旧成功不关闭新引导或接管导航', async ({ page }) => {
  await newProject(page)
  const original = new URL(page.url()).hash
  await page.request.put(mock, { data: { enabled: false } })
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let created: { id: string; title: string } | undefined
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const response = await route.fetch()
    created = await response.json()
    await held
    await route.fulfill({ response })
  })
  try {
    await page.goto('/')
    const dialog = page.getByRole('dialog', { name: '欢迎使用 Plein', exact: true })
    await dialog.getByRole('button', { name: '跳过', exact: true }).click()
    await dialog.getByRole('button', { name: /空白画布/ }).click()
    await expect.poll(() => !!created).toBe(true)
    await page.evaluate((hash) => {
      location.hash = hash
    }, original)
    await waitEngine(page)
    await page.evaluate(() => {
      location.hash = '/'
    })
    await expect(dialog.getByRole('button', { name: '跳过', exact: true })).toBeVisible()
    release()
    await expect(page.getByText(`已创建项目「${created!.title}」`, { exact: true })).toBeVisible()
    await expect(dialog).toBeVisible()
    expect(new URL(page.url()).hash).toBe('#/')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(page.locator(`[data-project="${created!.id}"]`)).toBeVisible()
  } finally {
    release()
    await page.request.put(mock, { data: { enabled: true } })
  }
})

test('关闭引导后迟到失败仍提示原因，不影响首页继续新建', async ({ page }) => {
  await page.request.put(mock, { data: { enabled: false } })
  let writes = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST' || ++writes !== 1) return route.continue()
    await held
    await route.fulfill({ status: 503, json: { message: '引导创建连接中断' } })
  })
  try {
    await page.goto('/')
    const dialog = page.getByRole('dialog', { name: '欢迎使用 Plein', exact: true })
    await dialog.getByRole('button', { name: '跳过', exact: true }).click()
    await dialog.getByRole('button', { name: /空白画布/ }).click()
    await expect.poll(() => writes).toBe(1)
    await dialog.getByRole('button', { name: '先看看项目列表', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    release()
    await expect(
      page.getByText('创建项目未获确认：引导创建连接中断', { exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: '新建项目', exact: true }).click()
    await waitEngine(page)
    expect(writes).toBe(2)
  } finally {
    release()
    await page.request.put(mock, { data: { enabled: true } })
  }
})

for (const exit of ['关闭', 'Escape']) {
  test(`引导创建短剧时${exit}并切回原画布，迟到完成不接管导航，稍后打开仍有模板`, async ({
    page,
  }) => {
    await newProject(page)
    const original = new URL(page.url()).hash
    expect((await page.request.put(mock, { data: { enabled: false } })).ok()).toBe(true)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let created: { id: string; lastCanvasId: string; title: string } | undefined
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      const response = await route.fetch()
      created = await response.json()
      await held
      await route.fulfill({ response })
    })
    try {
      await page.goto('/')
      const dialog = page.getByRole('dialog', { name: '欢迎使用 Plein', exact: true })
      await dialog.getByRole('button', { name: '跳过', exact: true }).click()
      await dialog.getByRole('button', { name: /从短剧模板开始/ }).click()
      await expect.poll(() => !!created).toBe(true)
      if (exit === '关闭') await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      else await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await page.evaluate((hash) => {
        location.hash = hash
      }, original)
      await waitEngine(page)
      release()
      await expect(page.getByText(`已创建项目「${created!.title}」`, { exact: true })).toBeVisible()
      expect(new URL(page.url()).hash).toBe(original)
      await page.evaluate(() => {
        location.hash = '/'
      })
      await expect(dialog).toHaveCount(0)
      await page
        .locator(`[data-project="${created!.id}"]`)
        .getByRole('link', { name: created!.title, exact: true })
        .click()
      await waitEngine(page)
      await expect(page.locator('.ui-toast')).toContainText('短剧模板已铺出')
      expect((await byName(page, '分镜（双击展开镜头）')).kind).toBe('node')
    } finally {
      release()
      await page.request.put(mock, { data: { enabled: true } })
    }
  })
}

test('引导创建等待有说明并防止重复提交，失败可重试且不丢步骤', async ({ page }) => {
  expect((await page.request.put(mock, { data: { enabled: false } })).ok()).toBe(true)
  let writes = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST' || ++writes !== 1) return route.continue()
    await held
    await route.fulfill({ status: 503, json: { message: '引导创建暂不可用' } })
  })
  try {
    await page.goto('/')
    const dialog = page.getByRole('dialog', { name: '欢迎使用 Plein', exact: true })
    await dialog.getByRole('button', { name: '跳过', exact: true }).click()
    await dialog.getByRole('button', { name: /空白画布/ }).evaluate((el) => {
      ;(el as HTMLButtonElement).click()
      ;(el as HTMLButtonElement).click()
    })
    await expect(dialog.getByRole('status')).toContainText('正在创建项目')
    await expect(dialog.getByRole('button', { name: '上一步', exact: true })).toBeDisabled()
    await expect.poll(() => writes).toBe(1)
    await dialog.screenshot({ path: test.info().outputPath('welcome-creating.png') })
    release()
    await expect(dialog.getByRole('alert')).toContainText('引导创建暂不可用')
    await expect(dialog.getByRole('button', { name: '上一步', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: /空白画布/ }).click()
    await waitEngine(page)
    expect(writes).toBe(2)
    expect(await page.evaluate(() => localStorage.getItem('plein.welcome'))).toBe('1')
  } finally {
    release()
    await page.request.put(mock, { data: { enabled: true } })
  }
})
