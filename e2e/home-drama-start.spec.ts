import { expect, test, type Page } from '@playwright/test'
import { elements, newProject, waitEngine } from './canvas'

const MOCK = '/api/providers/plein/mock/config'

async function expectTemplate(page: Page) {
  await waitEngine(page)
  await expect
    .poll(
      async () => (await elements(page)).filter((el) => el.nodeType === 'plein/storyboard').length,
    )
    .toBe(1)
  const all = await elements(page)
  for (const type of ['plein/llm', 'plein/image', 'plein/video', 'plein/speech', 'plein/sequence'])
    expect(
      all.some((el) => el.nodeType === type),
      type,
    ).toBe(true)
  expect(all.every((el) => el.status === undefined && el.results === 0)).toBe(true)
  const canvasId = new URL(page.url()).hash.split('/').at(-1)!
  const jobs = await page.request.get(`/api/canvases/${canvasId}/jobs`)
  expect(jobs.ok()).toBe(true)
  expect((await jobs.json()).jobs).toEqual([])
  return all.length
}

test.beforeEach(async ({ page }) => {
  // 已跳过首次引导的用户也必须能发现短剧流程。
  await page.addInitScript(() => localStorage.setItem('plein.welcome', '1'))
})

for (const configured of [true, false]) {
  test(`首页短剧入口：${configured ? '已有平台' : '未配置平台'}时只铺结构，可完整撤销重做`, async ({
    page,
  }) => {
    expect((await page.request.put(MOCK, { data: { enabled: configured } })).ok()).toBe(true)
    try {
      await page.goto('/')
      const start = page.getByRole('region', { name: '快速开始' })
      await expect(start.getByRole('button')).toHaveCount(6)
      await expect(page.getByRole('dialog', { name: '欢迎使用 Plein' })).toHaveCount(0)
      if (configured)
        await page.screenshot({ path: test.info().outputPath('home-drama-entry.png') })
      await start.getByRole('button', { name: /短剧模板/ }).click()
      const count = await expectTemplate(page)
      await expect(page.getByRole('complementary', { name: '创作下一步' })).toBeVisible()
      await page.keyboard.press('Escape')
      await page.keyboard.press('ControlOrMeta+z')
      await expect.poll(async () => (await elements(page)).length).toBe(0)
      await page.keyboard.press('ControlOrMeta+Shift+z')
      await expect.poll(async () => (await elements(page)).length).toBe(count)
      await page.screenshot({ path: test.info().outputPath('home-drama-structure.png') })
    } finally {
      await page.request.put(MOCK, { data: { enabled: true } })
    }
  })
}

test('首页短剧入口等待期间防重复，失败后可从同一入口重试', async ({ page }) => {
  let writes = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST' || ++writes !== 1) return route.continue()
    await held
    await route.fulfill({ status: 503, json: { message: '短剧项目暂不可用' } })
  })
  try {
    await page.goto('/')
    const button = page.getByRole('button', { name: /短剧模板/ })
    await button.evaluate((el) => {
      ;(el as HTMLButtonElement).click()
      ;(el as HTMLButtonElement).click()
    })
    await expect.poll(() => writes).toBe(1)
    await expect(button).toBeDisabled()
    await expect(page.getByRole('status')).toContainText('正在创建项目')
    release()
    await expect(page.getByRole('alert')).toContainText('短剧项目暂不可用')
    await expect(button).toBeEnabled()
    await button.click()
    await expectTemplate(page)
    expect(writes).toBe(2)
  } finally {
    release()
  }
})

test('首页短剧创建后切到旧画布，迟到应答不导航，稍后打开只插入一次', async ({ page }) => {
  await newProject(page)
  const original = new URL(page.url()).hash
  await page.goto('/')
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let result: { id: string; title: string; lastCanvasId: string } | undefined
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const response = await route.fetch()
    result = await response.json()
    await held
    await route.fulfill({ response })
  })
  try {
    await page.getByRole('button', { name: /短剧模板/ }).click()
    await expect.poll(() => !!result).toBe(true)
    await page.evaluate((hash) => {
      location.hash = hash
    }, original)
    await waitEngine(page)
    release()
    await expect(page.getByText(`已创建项目「${result!.title}」`, { exact: true })).toBeVisible()
    expect(new URL(page.url()).hash).toBe(original)
    await page.evaluate(() => {
      location.hash = '/'
    })
    await page
      .locator(`[data-project="${result!.id}"]`)
      .getByRole('link', { name: result!.title, exact: true })
      .click()
    const count = await expectTemplate(page)
    await page.reload()
    await waitEngine(page)
    await expect.poll(async () => (await elements(page)).length).toBe(count)
  } finally {
    release()
  }
})
