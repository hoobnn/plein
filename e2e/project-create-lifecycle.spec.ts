import { expect, test } from './fixtures'
import { elements, newProject, waitEngine } from './canvas'

test('新建项目等待时有明确状态，连续触发只创建一次', async ({ page }) => {
  await newProject(page)
  await page.goto('/')
  let writes = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    writes++
    await held
    await route.continue()
  })
  try {
    await page.getByRole('button', { name: '新建项目', exact: true }).evaluate((el) => {
      ;(el as HTMLButtonElement).click()
      ;(el as HTMLButtonElement).click()
    })
    await expect(page.getByRole('status')).toContainText('正在创建项目')
    await expect.poll(() => writes).toBe(1)
    for (const button of await page.locator('.home-quick, .home-new').all())
      await expect(button).toBeDisabled()
    await page.screenshot({ path: test.info().outputPath('project-creating.png') })
    release()
    await waitEngine(page)
    expect(writes).toBe(1)
  } finally {
    release()
  }
})

test('快速开始创建途中离开首页，迟到成功不打断当前画布，稍后打开仍有指定节点', async ({ page }) => {
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
    await page.getByRole('button', { name: /剧本创作/ }).click()
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
    const card = page.locator(`[data-project="${result!.id}"]`)
    await expect(card).toBeVisible()
    await card.getByRole('link', { name: result!.title, exact: true }).click()
    await waitEngine(page)
    await expect
      .poll(async () => (await elements(page)).filter((el) => el.nodeType === 'plein/llm').length)
      .toBe(1)
  } finally {
    release()
  }
})

test('新建失败后恢复全部入口，重试成功不残留错误', async ({ page }) => {
  await newProject(page)
  await page.goto('/')
  let failing = true
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'POST' && failing
      ? route.fulfill({ status: 503, json: { message: '创建暂不可用' } })
      : route.continue(),
  )
  await page.getByRole('button', { name: /图片生成/ }).click()
  await expect(page.getByRole('alert')).toContainText('创建暂不可用')
  await expect(page.getByRole('button', { name: '新建项目', exact: true })).toBeEnabled()
  failing = false
  await page.getByRole('button', { name: /图片生成/ }).click()
  await waitEngine(page)
  await expect
    .poll(async () => (await elements(page)).filter((el) => el.nodeType === 'plein/image').length)
    .toBe(1)
  await page.goto('/')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('离开首页后创建失败仍提示原因，不影响当前画布或新一次创建', async ({ page }) => {
  await newProject(page)
  const original = new URL(page.url()).hash
  await page.goto('/')
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let writes = 0
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST' || ++writes !== 1) return route.continue()
    await held
    await route.fulfill({ status: 503, json: { message: '创建连接中断' } })
  })
  try {
    await page.getByRole('button', { name: '新建项目', exact: true }).click()
    await expect.poll(() => writes).toBe(1)
    await page.evaluate((hash) => {
      location.hash = hash
    }, original)
    await waitEngine(page)
    release()
    await expect(page.getByText('创建项目未获确认：创建连接中断', { exact: true })).toBeVisible()
    expect(new URL(page.url()).hash).toBe(original)
    await page.evaluate(() => {
      location.hash = '/'
    })
    await expect(page.getByRole('button', { name: '新建项目', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '新建项目', exact: true }).click()
    await waitEngine(page)
    expect(writes).toBe(2)
  } finally {
    release()
  }
})
