import { expect, type Page, test } from '@playwright/test'
import { newProject, waitEngine } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const canvasId = decodeURIComponent(page.url().split('#/c/')[1]!)
  const canvas = await (await page.request.get(`/api/canvases/${canvasId}`)).json()
  const project = await (await page.request.get(`/api/projects/${canvas.projectId}`)).json()
  const node = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/text',
      name: '应保留的画布内容',
      params: {},
      x: 400,
      y: 300,
    }),
  )
  await expect
    .poll(async () =>
      (await page.request.get(`/api/canvases/${canvasId}/nodes/${node}/input`)).status(),
    )
    .toBe(200)
  return { canvas, project }
}

test('项目首次读取失败可重试，窄窗口保留错误、文档和恢复焦点', async ({ page }) => {
  const { project } = await fixture(page)
  await page.setViewportSize({ width: 320, height: 900 })
  let failed = true
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let reads = 0
  await page.route(`**/api/projects/${project.id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    reads++
    if (failed) return route.fulfill({ status: 503, json: { message: '项目信息暂时不可用' } })
    await pending
    return route.continue()
  })
  try {
    await page.reload()
    await waitEngine(page)
    await page.getByRole('button', { name: '项目信息加载失败', exact: true }).click()
    const info = page.getByRole('dialog', { name: '项目信息', exact: true })
    await expect(info.getByRole('alert')).toContainText('项目信息暂时不可用')
    const retry = info.getByRole('button', { name: '重新加载项目信息', exact: true })
    failed = false
    const before = reads
    await retry.click()
    await expect.poll(() => reads).toBeGreaterThan(before)
    await expect(retry).toBeDisabled()
    await expect(info.getByRole('alert')).toContainText('项目信息暂时不可用')
    await page.screenshot({
      path: test.info().outputPath('project-read-retrying.png'),
      animations: 'disabled',
    })
    release()
    await expect(info).toHaveCount(0)
    const title = page.getByRole('button', { name: project.title, exact: true })
    await expect(title).toBeFocused()
    expect(
      await page.evaluate(() => [...window.__plein.engine.doc.elements()].map((el) => el.name)),
    ).toContain('应保留的画布内容')
    await title.click()
    await expect(page.getByRole('dialog', { name: '重命名项目', exact: true })).toBeVisible()
  } finally {
    release()
  }
})

test('项目读取等待有状态，期间仍可编辑，成功后返回项目入口', async ({ page }) => {
  const { project } = await fixture(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/api/projects/${project.id}`, async (route) => {
    await pending
    return route.continue()
  })
  try {
    await page.reload()
    await waitEngine(page)
    await page.getByRole('button', { name: '项目信息正在加载', exact: true }).click()
    const info = page.getByRole('dialog', { name: '项目信息', exact: true })
    await expect(info.getByRole('status')).toHaveText('正在读取项目信息…')
    await expect(info.getByRole('button', { name: '重新加载项目信息', exact: true })).toBeDisabled()
    await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/text',
        name: '读取期间新建',
        params: {},
        x: 900,
        y: 300,
      }),
    )
    release()
    await expect(info).toHaveCount(0)
    await expect(page.getByRole('button', { name: project.title, exact: true })).toBeFocused()
    expect(
      await page.evaluate(() => [...window.__plein.engine.doc.elements()].map((el) => el.name)),
    ).toContain('读取期间新建')
  } finally {
    release()
  }
})

test('项目缓存刷新失败仍显示已确认新名称，可改名并重试恢复', async ({ page }) => {
  const { project } = await fixture(page)
  await page.setViewportSize({ width: 390, height: 900 })
  const newName = `已确认的新名称${'W'.repeat(150)}`
  let failed = true
  await page.route(`**/api/projects/${project.id}`, (route) =>
    route.request().method() === 'GET' && failed
      ? route.fulfill({ status: 503, json: { message: '刷新项目暂时失败' } })
      : route.continue(),
  )
  await page.getByRole('button', { name: project.title, exact: true }).click()
  const rename = page.getByRole('dialog', { name: '重命名项目', exact: true })
  await rename.getByRole('textbox').fill(newName)
  await rename.getByRole('button', { name: '保存', exact: true }).click()
  await expect(rename).toHaveCount(0)
  const title = page.getByRole('button', { name: '项目信息刷新失败', exact: true })
  await expect(title).toHaveText(newName)
  await title.click()
  const info = page.getByRole('dialog', { name: '项目信息', exact: true })
  await expect(info.getByRole('alert')).toContainText('刷新项目暂时失败')
  expect(await info.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await info.screenshot({
    path: test.info().outputPath('cached-project-read-failed.png'),
    animations: 'disabled',
  })
  await info.getByRole('button', { name: '重命名项目', exact: true }).click()
  await expect(rename.getByRole('textbox')).toHaveValue(newName)
  await rename.getByRole('button', { name: '取消', exact: true }).click()
  await expect(rename).toHaveCount(0)
  await title.click()
  failed = false
  await info.getByRole('button', { name: '重新加载项目信息', exact: true }).click()
  await expect(info).toHaveCount(0)
  await expect(page.getByRole('button', { name: newName, exact: true })).toBeFocused()
})

test('项目信息重试期间切换项目，迟到成功不接管新项目焦点', async ({ page }) => {
  const { project } = await fixture(page)
  const otherProject = await (
    await page.request.post('/api/projects', { data: { title: '新项目焦点' } })
  ).json()
  const other = await (
    await page.request.post('/api/canvases', {
      data: { projectId: otherProject.id, title: '新项目画布' },
    })
  ).json()
  let failed = true
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let retryStarted = false
  await page.route(`**/api/projects/${project.id}`, async (route) => {
    if (failed) return route.fulfill({ status: 503, json: { message: '旧项目读取失败' } })
    retryStarted = true
    await pending
    return route.continue()
  })
  try {
    await page.reload()
    await waitEngine(page)
    await page.getByRole('button', { name: '项目信息加载失败', exact: true }).click()
    failed = false
    await page.getByRole('button', { name: '重新加载项目信息', exact: true }).click()
    await expect.poll(() => retryStarted).toBe(true)
    await page.evaluate((id) => {
      location.hash = `#/c/${id}`
    }, other.id)
    const title = page.getByRole('button', { name: '新项目焦点', exact: true })
    await expect(title).toBeVisible()
    await title.focus()
    const finished = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/projects/${project.id}`) && response.status() === 200,
    )
    release()
    await (await finished).finished()
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    await expect(page.getByRole('dialog', { name: '项目信息', exact: true })).toHaveCount(0)
    await expect(title).toBeFocused()
    await expect(page).toHaveURL(new RegExp(`#/c/${other.id}$`))
  } finally {
    release()
  }
})
