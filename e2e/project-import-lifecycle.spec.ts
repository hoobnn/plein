import { expect, type Page, type Route, test } from './fixtures'
import type { ProjectImportPreview } from '../packages/protocol/src/project-package'
import { newProject, waitEngine } from './canvas'

function discardedTokens(page: Page) {
  const deleted = new Set<string>()
  page.on('response', (response) => {
    if (
      response.request().method() === 'DELETE' &&
      /\/api\/project-imports\/[^/?]+$/.test(response.url()) &&
      response.ok()
    )
      deleted.add(response.url().split('/').at(-1)!)
  })
  return deleted
}

test('导入已完成但确认响应丢失时显示未确认状态，刷新首页结果且不重复提交', async ({ page }) => {
  const { file, title, projectCount } = await packageFile(page)
  let commits = 0
  await page.route('**/api/project-imports/*', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    commits++
    const actual = await route.fetch()
    expect(actual.status()).toBe(201)
    await route.fulfill({ status: 503, json: { message: '未收到导入确认' } })
  })
  await page.getByTestId('project-import-input').setInputFiles(file)
  await page
    .getByRole('dialog', { name: `导入「${title}」`, exact: true })
    .getByRole('button', { name: '作为副本导入', exact: true })
    .click()
  const unknown = page.getByRole('dialog', { name: '导入未获确认', exact: true })
  await expect(unknown).toBeVisible()
  await expect(unknown).toContainText('请先在首页检查是否已经导入')
  await expect(unknown.getByRole('button', { name: '重新校验', exact: true })).toHaveCount(0)
  expect(commits).toBe(1)
  await unknown.screenshot({ path: test.info().outputPath('import-confirmation-unknown.png') })
  await unknown.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('link', { name: `${title}（副本）`, exact: true })).toBeVisible()
  expect((await (await page.request.get('/api/projects')).json()).length).toBe(projectCount + 1)
})

async function packageFile(page: Page) {
  await newProject(page)
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
  const metadata = await (await page.request.get(`/api/canvases/${canvas}`)).json()
  const project = await (await page.request.get(`/api/projects/${metadata.projectId}`)).json()
  project.title = `导入生命周期 ${Date.now()}`
  expect(
    (
      await page.request.patch(`/api/projects/${project.id}`, { data: { title: project.title } })
    ).ok(),
  ).toBe(true)
  const response = await page.request.get(`/api/projects/${project.id}/package`)
  expect(response.ok()).toBe(true)
  const file = {
    name: '生命周期.plein',
    mimeType: 'application/octet-stream',
    buffer: await response.body(),
  }
  const projectCount = (await (await page.request.get('/api/projects')).json()).length as number
  await page.goto('/')
  return {
    file,
    title: project.title as string,
    projectId: project.id as string,
    canvas,
    projectCount,
  }
}

test('预检失败可直接重新校验同一文件，取消预览后不导入', async ({ page }) => {
  const { file, title, projectCount } = await packageFile(page)
  let failing = true
  let commits = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/project-imports\/[^/?]+$/.test(r.url())) commits++
  })
  await page.route('**/api/project-imports', (route) =>
    failing ? route.fulfill({ status: 503, json: { message: '预检暂不可用' } }) : route.continue(),
  )
  await page.getByTestId('project-import-input').setInputFiles(file)
  const error = page.getByRole('dialog', { name: '无法导入', exact: true })
  await expect(error).toContainText('预检暂不可用')
  failing = false
  await error.getByRole('button', { name: '重新校验', exact: true }).click()
  const preview = page.getByRole('dialog', { name: `导入「${title}」`, exact: true })
  await expect(preview).toBeVisible()
  await preview.getByRole('button', { name: '取消', exact: true }).click()
  await expect(preview).toHaveCount(0)
  expect(commits).toBe(0)
  expect((await (await page.request.get('/api/projects')).json()).length).toBe(projectCount)
})

test('确认导入中不能取消或重复确认，完成后只创建一个副本', async ({ page }) => {
  const { file, title, projectCount } = await packageFile(page)
  let pending: Route | undefined
  let commits = 0
  await page.route('**/api/project-imports/*', (route) => {
    if (route.request().method() === 'POST') {
      commits++
      pending = route
    } else void route.continue()
  })
  await page.getByTestId('project-import-input').setInputFiles(file)
  const preview = page.getByRole('dialog', { name: `导入「${title}」`, exact: true })
  await preview.getByRole('button', { name: '作为副本导入', exact: true }).evaluate((el) => {
    ;(el as HTMLButtonElement).click()
    ;(el as HTMLButtonElement).click()
  })
  await expect.poll(() => !!pending).toBe(true)
  await expect(preview.getByRole('button', { name: '取消', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(preview).toBeVisible()
  await preview.screenshot({ path: test.info().outputPath('import-confirming.png') })
  expect(commits).toBe(1)
  await pending!.continue()
  await waitEngine(page)
  await expect(page.getByRole('button', { name: `${title}（副本）`, exact: true })).toBeVisible()
  expect((await (await page.request.get('/api/projects')).json()).length).toBe(projectCount + 1)
})

test('离开导入页面后迟到的成功只刷新项目列表，不把用户带离当前画布', async ({ page }) => {
  const { file, title, canvas, projectCount } = await packageFile(page)
  let pending: { route: Route; response: Awaited<ReturnType<Route['fetch']>> } | undefined
  await page.route('**/api/project-imports/*', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    pending = { route, response: await route.fetch() }
  })
  await page.getByTestId('project-import-input').setInputFiles(file)
  await page
    .getByRole('dialog', { name: `导入「${title}」`, exact: true })
    .getByRole('button', { name: '作为副本导入', exact: true })
    .click()
  await expect.poll(() => !!pending).toBe(true)
  await page.evaluate((canvas) => {
    location.hash = `/c/${canvas}`
  }, canvas)
  await waitEngine(page)
  await pending!.route.fulfill({ response: pending!.response })
  await expect(page.getByText(`已导入项目「${title}（副本）」`, { exact: true })).toBeVisible()
  expect(new URL(page.url()).hash).toBe(`#/c/${canvas}`)
  expect((await (await page.request.get('/api/projects')).json()).length).toBe(projectCount + 1)
})

test('取消预检后迟到的临时结果会释放，不重新打开预览或留下可提交令牌', async ({ page }) => {
  const { file } = await packageFile(page)
  const held: Array<{ route: Route; preview: ProjectImportPreview }> = []
  let releasing = false
  const deleted = discardedTokens(page)
  await page.route('**/api/project-imports', async (route) => {
    const response = await route.fetch()
    const preview = (await response.json()) as ProjectImportPreview
    held.push({ route, preview })
    if (releasing) await route.fulfill({ json: preview })
  })
  await page.getByTestId('project-import-input').setInputFiles(file)
  await expect.poll(() => held.length).toBeGreaterThan(0)
  await page
    .getByRole('dialog', { name: '导入项目包', exact: true })
    .getByRole('button', { name: '取消', exact: true })
    .click()
  releasing = true
  for (const item of [...held]) await item.route.fulfill({ json: item.preview })
  await expect.poll(() => held.every((item) => deleted.has(item.preview.token))).toBe(true)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  for (const item of held) {
    const response = await page.request.post(`/api/project-imports/${item.preview.token}`, {
      data: {},
    })
    expect(response.status()).toBe(404)
  }
})

test('取消后立即换文件，旧预检不覆盖新预览，取消新文件会释放正确令牌', async ({ page }) => {
  const { file, title, projectId, projectCount } = await packageFile(page)
  const deleted = discardedTokens(page)
  const held: Array<{ route: Route; preview: ProjectImportPreview }> = []
  const previews: ProjectImportPreview[] = []
  let releasing = false
  await page.route('**/api/project-imports', async (route) => {
    const response = await route.fetch()
    const preview = (await response.json()) as ProjectImportPreview
    previews.push(preview)
    if (preview.title !== title || releasing) await route.fulfill({ json: preview })
    else held.push({ route, preview })
  })
  await page.getByTestId('project-import-input').setInputFiles(file)
  await expect.poll(() => held.length).toBeGreaterThan(0)
  await page
    .getByRole('dialog', { name: '导入项目包', exact: true })
    .getByRole('button', { name: '取消', exact: true })
    .click()
  const nextTitle = `重新选择 ${Date.now()}`
  expect(
    (await page.request.patch(`/api/projects/${projectId}`, { data: { title: nextTitle } })).ok(),
  ).toBe(true)
  const next = await page.request.get(`/api/projects/${projectId}/package`)
  expect(next.ok()).toBe(true)
  await page
    .getByTestId('project-import-input')
    .setInputFiles({ ...file, name: '另一个项目.plein', buffer: await next.body() })
  const preview = page.getByRole('dialog', { name: `导入「${nextTitle}」`, exact: true })
  await expect(preview).toBeVisible()
  releasing = true
  for (const item of [...held]) await item.route.fulfill({ json: item.preview })
  await expect(preview).toBeVisible()
  await preview.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(() => previews.every((item) => deleted.has(item.token))).toBe(true)
  for (const item of previews) {
    expect(
      (await page.request.post(`/api/project-imports/${item.token}`, { data: {} })).status(),
    ).toBe(404)
  }
  expect((await (await page.request.get('/api/projects')).json()).length).toBe(projectCount)
})

test('损坏的项目包显示具体错误，不提供反复校验同一坏文件的入口', async ({ page }) => {
  const { file } = await packageFile(page)
  const response = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/project-imports'),
  )
  await page
    .getByTestId('project-import-input')
    .setInputFiles({ ...file, buffer: Buffer.from('not a project package') })
  expect((await response).status()).toBe(422)
  const error = page.getByRole('dialog', { name: '无法导入', exact: true })
  await expect(error).toBeVisible()
  await expect(error.getByRole('button', { name: '重新校验', exact: true })).toHaveCount(0)
  await error.screenshot({ path: test.info().outputPath('import-precheck-invalid.png') })
  await error.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(error).toHaveCount(0)
})

test('导入成功后的首页刷新再慢，也不在用户切回原画布后迟到跳转', async ({ page }) => {
  const { file, title, canvas } = await packageFile(page)
  await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible()
  let pending: { route: Route; response: Awaited<ReturnType<Route['fetch']>> } | undefined
  await page.route('**/api/projects', async (route) => {
    pending = { route, response: await route.fetch() }
  })
  await page.getByTestId('project-import-input').setInputFiles(file)
  await page
    .getByRole('dialog', { name: `导入「${title}」`, exact: true })
    .getByRole('button', { name: '作为副本导入', exact: true })
    .click()
  await expect.poll(() => !!pending).toBe(true)
  await page.evaluate((canvas) => {
    location.hash = `/c/${canvas}`
  }, canvas)
  await waitEngine(page)
  const received = page.waitForResponse(
    (response) => response.request().method() === 'GET' && response.url().endsWith('/api/projects'),
  )
  await pending!.route.fulfill({ response: pending!.response })
  await (await received).finished()
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
  expect(new URL(page.url()).hash).toBe(`#/c/${canvas}`)
  await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible()
})
