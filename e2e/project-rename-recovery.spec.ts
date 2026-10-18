import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const canvasId = decodeURIComponent(page.url().split('#/c/')[1]!)
  const canvas = await (await page.request.get(`/api/canvases/${canvasId}`)).json()
  await page.goto('/')
  const card = page.locator(`[data-project="${canvas.projectId}"]`)
  await expect(card).toBeVisible()
  return { card, projectId: canvas.projectId as string }
}

test('首页项目改名失败保留正文并可重试，窄窗口明确显示错误且不产生未处理异常', async ({ page }) => {
  const { card, projectId } = await fixture(page)
  await page.setViewportSize({ width: 390, height: 700 })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  let writes = 0
  await page.route(`**/api/projects/${projectId}`, (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    writes++
    if (writes === 1)
      return route.fulfill({ status: 503, json: { message: '项目改名暂时失败，请重试' } })
    return route.continue()
  })
  await card.getByRole('button', { name: '重命名', exact: true }).click()
  await card.getByRole('textbox').fill('雨后清晨 🌧️ 未丢失的名称')
  await page.keyboard.press('Enter')
  const error = card.getByRole('alert')
  await expect(error).toContainText('项目改名暂时失败，请重试')
  const input = card.getByRole('textbox', { name: '项目名称', exact: true })
  await expect(input).toHaveValue('雨后清晨 🌧️ 未丢失的名称')
  await expect(input).toBeFocused()
  await expect(error).toBeInViewport()
  await card.screenshot({
    path: test.info().outputPath('project-rename-error.png'),
    animations: 'disabled',
  })
  await input.fill('雨后清晨 🌧️ 重试成功')
  await page.keyboard.press('Enter')
  await expect(card.getByRole('link', { name: '雨后清晨 🌧️ 重试成功', exact: true })).toBeVisible()
  await expect(error).toHaveCount(0)
  expect((await (await page.request.get(`/api/projects/${projectId}`)).json()).title).toBe(
    '雨后清晨 🌧️ 重试成功',
  )
  expect(writes).toBe(2)
  expect(errors).toEqual([])
})

test('首页项目改名保存中有反馈并禁止重复提交，成功后恢复操作', async ({ page }) => {
  const { card, projectId } = await fixture(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let writes = 0
  await page.route(`**/api/projects/${projectId}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    writes++
    await pending
    await route.continue()
  })
  try {
    const rename = card.getByRole('button', { name: '重命名', exact: true })
    await rename.click()
    await card.getByRole('textbox').fill('等待保存的项目')
    await page.keyboard.press('Enter')
    await expect.poll(() => writes).toBe(1)
    await expect(card.getByRole('status')).toContainText('正在保存项目名称')
    await expect(rename).toBeDisabled()
    release()
    await expect(card.getByRole('link', { name: '等待保存的项目', exact: true })).toBeVisible()
    await expect(rename).toBeEnabled()
    await expect(card.getByRole('status')).toHaveCount(0)
    expect(writes).toBe(1)
  } finally {
    release()
  }
})

test('首页项目改名 Esc 和空白不写入，回车后失焦只保存一次', async ({ page }) => {
  const { card, projectId } = await fixture(page)
  let writes = 0
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().endsWith(`/api/projects/${projectId}`))
      writes++
  })
  const rename = card.getByRole('button', { name: '重命名', exact: true })
  for (const action of ['cancel', 'empty'] as const) {
    await rename.click()
    await card.getByRole('textbox').fill(action === 'cancel' ? '应丢弃的名称' : '   ')
    await page.keyboard.press(action === 'cancel' ? 'Escape' : 'Enter')
    await expect(card.getByRole('textbox')).toHaveCount(0)
  }
  expect(writes).toBe(0)
  await rename.click()
  await card.getByRole('textbox').fill('  一次保存  ')
  await page.keyboard.press('Enter')
  await page.getByRole('heading', { name: /^我的项目/ }).click()
  await expect(card.getByRole('link', { name: '一次保存', exact: true })).toBeVisible()
  expect(writes).toBe(1)
})

test('改名迟到失败恢复草稿，但不抢走用户已移到搜索框的焦点', async ({ page }) => {
  const { card, projectId } = await fixture(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let writes = 0
  await page.route(`**/api/projects/${projectId}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    writes++
    await pending
    return route.fulfill({ status: 503, json: { message: '迟到的改名失败' } })
  })
  try {
    await card.getByRole('button', { name: '重命名', exact: true }).click()
    await card.getByRole('textbox').fill('保留草稿且不打断其他操作')
    await page.keyboard.press('Enter')
    await expect.poll(() => writes).toBe(1)
    const search = page.getByRole('searchbox', { name: '搜索项目', exact: true })
    await search.focus()
    release()
    await expect(card.getByRole('alert')).toContainText('迟到的改名失败')
    await expect(card.getByRole('textbox', { name: '项目名称', exact: true })).toHaveValue(
      '保留草稿且不打断其他操作',
    )
    await expect(search).toBeFocused()
    expect(writes).toBe(1)
  } finally {
    release()
  }
})
