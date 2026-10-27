import { expect, type Page, test } from './fixtures'
import { newProject, waitEngine } from './canvas'

async function emptyProject(page: Page) {
  await newProject(page)
  const canvasId = page.url().split('#/c/')[1]!
  const canvas = await (await page.request.get(`/api/canvases/${canvasId}`)).json()
  await page.goto('/')
  expect((await page.request.delete(`/api/canvases/${canvasId}`)).ok()).toBe(true)
  return canvas.projectId as string
}

test('打开空项目期间显示加载状态，开发态重放也只创建一张画布', async ({ page }) => {
  const id = await emptyProject(page)
  let writes = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/api/projects/${id}`, async (route) => {
    await held
    await route.continue()
  })
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/canvases')) writes++
  })
  try {
    await page.goto(`/#/p/${id}`)
    await expect(page.getByRole('status')).toContainText('正在打开项目')
    release()
    await waitEngine(page)
    expect(writes).toBe(1)
    expect((await (await page.request.get(`/api/projects/${id}/canvases`)).json()).length).toBe(1)
  } finally {
    release()
  }
})

test('项目读取失败可原地重试，重试期间不能重复提交', async ({ page }) => {
  const id = await emptyProject(page)
  let failing = true
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/api/projects/${id}`, async (route) => {
    if (failing) return route.fulfill({ status: 503, json: { message: '项目读取暂不可用' } })
    await held
    await route.continue()
  })
  await page.goto(`/#/p/${id}`)
  await expect(page.getByRole('alert')).toContainText('项目读取暂不可用')
  failing = false
  try {
    await page.screenshot({ path: test.info().outputPath('project-open-error.png') })
    await page.getByRole('button', { name: '重新打开', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('正在打开项目')
    await expect(page.getByRole('button', { name: '重新打开', exact: true })).toHaveCount(0)
    release()
    await waitEngine(page)
    expect((await (await page.request.get(`/api/projects/${id}/canvases`)).json()).length).toBe(1)
  } finally {
    release()
  }
})

for (const committed of [false, true]) {
  test(`首画布${committed ? '已创建但确认丢失' : '创建失败'}后重新打开，不额外创建画布`, async ({
    page,
  }) => {
    const id = await emptyProject(page)
    let writes = 0
    await page.route('**/api/canvases', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      writes++
      if (writes !== 1) return route.continue()
      if (committed) expect((await route.fetch()).status()).toBe(201)
      await route.fulfill({ status: 503, json: { message: '未收到画布创建确认' } })
    })
    await page.goto(`/#/p/${id}`)
    await expect(page.getByRole('alert')).toContainText('未收到画布创建确认')
    await page.getByRole('button', { name: '重新打开', exact: true }).click()
    await waitEngine(page)
    expect(writes).toBe(committed ? 1 : 2)
    expect((await (await page.request.get(`/api/projects/${id}/canvases`)).json()).length).toBe(1)
  })
}

test('打开空项目后返回首页，迟到的读取不再创建画布或跳转', async ({ page }) => {
  const id = await emptyProject(page)
  let reads = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/api/projects/${id}`, async (route) => {
    reads++
    await held
    await route.continue()
  })
  let writes = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/canvases')) writes++
  })
  try {
    await page.goto(`/#/p/${id}`)
    await expect.poll(() => reads).toBeGreaterThan(0)
    await page.evaluate(() => {
      location.hash = '/'
    })
    await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible()
    const received = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${id}`))
    release()
    await (await received).finished()
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    expect(writes).toBe(0)
    expect((await (await page.request.get(`/api/projects/${id}/canvases`)).json()).length).toBe(0)
    expect(new URL(page.url()).hash).toBe('#/')
  } finally {
    release()
  }
})

test('首画布创建等待期间离开再回来，复用同一次创建且只打开一张画布', async ({ page }) => {
  const id = await emptyProject(page)
  let writes = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/canvases', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    writes++
    await held
    await route.continue()
  })
  try {
    await page.goto(`/#/p/${id}`)
    await expect.poll(() => writes).toBe(1)
    await page.evaluate(() => {
      location.hash = '/'
    })
    await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible()
    const read = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${id}`))
    await page.evaluate((id) => {
      location.hash = `/p/${id}`
    }, id)
    await (await read).finished()
    await expect(page.getByRole('status')).toContainText('正在打开项目')
    expect(writes).toBe(1)
    release()
    await waitEngine(page)
    expect(writes).toBe(1)
    expect((await (await page.request.get(`/api/projects/${id}/canvases`)).json()).length).toBe(1)
  } finally {
    release()
  }
})
