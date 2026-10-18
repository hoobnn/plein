import type { CanvasCheckpoint, CreateCheckpoint } from '../packages/protocol/src/checkpoints'
import { expect, type Page, test } from '@playwright/test'
import { article, checkpointPair, panel } from './checkpoints'

async function fixture(page: Page) {
  let saved: CreateCheckpoint | undefined
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/canvases\/[^/]+\/checkpoints$/.test(request.url()))
      saved = request.postDataJSON() as CreateCheckpoint
  })
  const f = await checkpointPair(page)
  const canvasId = decodeURIComponent(page.url().split('#/c/')[1]!)
  expect(saved).toBeDefined()
  for (let i = 0; i < 49; i++) {
    const response = await page.request.post(`/api/canvases/${canvasId}/checkpoints`, {
      data: { ...saved!, name: `分页版本 ${String(i + 1).padStart(2, '0')}` },
    })
    expect(response.status()).toBe(201)
  }
  await panel(page).getByRole('button', { name: '刷新', exact: true }).click()
  await expect(panel(page).getByRole('article')).toHaveCount(50)
  const more = panel(page).getByRole('button', { name: '加载更多检查点', exact: true })
  await expect(more).toBeEnabled()
  return { ...f, more, listPath: `/api/projects/${f.projectId}/checkpoints` }
}

const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )

test('真实检查点分页失败保留已加载条目和预览，重试成功清除旧错误且只加载一份', async ({ page }) => {
  const f = await fixture(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let fail = true,
    reads = 0
  await page.route(`**${f.listPath}?*`, async (route) => {
    if (!new URL(route.request().url()).searchParams.has('cursor')) return route.continue()
    reads++
    if (fail) return route.fulfill({ status: 503, json: { message: '下一页暂时不可用' } })
    await pending
    await route.continue()
  })
  await article(page, f.second.name).getByRole('button', { name: '只读预览', exact: true }).click()
  await expect(panel(page).getByTestId('checkpoint-preview')).toContainText('第二版正文')
  await f.more.click()
  await expect(panel(page).getByRole('alert')).toContainText('下一页暂时不可用')
  await expect(panel(page).getByRole('article')).toHaveCount(50)
  await expect(f.more).toBeEnabled()
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 700 })
    await expect(panel(page).getByRole('alert')).toBeInViewport({ ratio: 1 })
    await f.more.scrollIntoViewIfNeeded()
    await expect(f.more).toBeInViewport({ ratio: 1 })
  }
  await panel(page).screenshot({
    path: test.info().outputPath('checkpoint-pagination-error-mobile.png'),
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  fail = false
  try {
    await f.more.click()
    await expect.poll(() => reads).toBe(2)
    await expect(
      panel(page).getByRole('button', { name: '正在加载更多…', exact: true }),
    ).toBeDisabled()
    release()
  } finally {
    release()
  }
  await expect(panel(page).getByRole('article')).toHaveCount(51)
  await expect(panel(page).getByRole('alert')).toHaveCount(0)
  await expect(article(page, f.first.name)).toHaveCount(1)
  await expect(panel(page).getByTestId('checkpoint-preview')).toContainText('第二版正文')
  expect(reads).toBe(2)
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
})

test('相邻分页包含重叠条目时按检查点身份合并，不重复显示', async ({ page }) => {
  const f = await fixture(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route(`**${f.listPath}?*`, async (route) => {
    if (!new URL(route.request().url()).searchParams.has('cursor')) return route.continue()
    const response = await route.fetch()
    const result = (await response.json()) as {
      items: CanvasCheckpoint[]
      nextCursor: string | null
    }
    await route.fulfill({ response, json: { ...result, items: [f.second, ...result.items] } })
  })
  await f.more.click()
  await expect(article(page, f.first.name)).toHaveCount(1)
  await expect(panel(page).getByRole('article')).toHaveCount(51)
  await expect(article(page, f.second.name)).toHaveCount(1)
  expect(errors).toEqual([])
})

test('加载旧分页期间保存新检查点，迟到旧页不追加到刷新的列表', async ({ page }) => {
  const f = await fixture(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let received = false,
    settled = false
  await page.route(`**${f.listPath}?*`, async (route) => {
    if (!new URL(route.request().url()).searchParams.has('cursor')) return route.continue()
    const response = await route.fetch()
    received = true
    await pending
    await route.fulfill({ response }).catch(() => {})
    settled = true
  })
  try {
    await f.more.click()
    await expect.poll(() => received).toBe(true)
    await panel(page)
      .getByRole('textbox', { name: '检查点名称', exact: true })
      .fill('分页等待时保存的新版本')
    await panel(page).getByRole('button', { name: '保存当前画布', exact: true }).click()
    await expect(article(page, '分页等待时保存的新版本')).toBeVisible()
    await expect(panel(page).getByRole('button', { name: '刷新', exact: true })).toBeEnabled()
    release()
    await expect.poll(() => settled).toBe(true)
    await frames(page)
    await expect(article(page, f.first.name)).toHaveCount(0)
    await expect(panel(page).getByRole('article')).toHaveCount(50)
    await expect(panel(page).getByTestId('checkpoint-preview')).toContainText('第二版正文')
  } finally {
    release()
  }
})

test('删除触发刷新时，迟到旧分页失败不能抢走加载状态或写入错误', async ({ page }) => {
  const f = await fixture(page)
  let releasePage!: () => void, releaseRefresh!: () => void
  const paging = new Promise<void>((resolve) => {
    releasePage = resolve
  })
  const refreshing = new Promise<void>((resolve) => {
    releaseRefresh = resolve
  })
  let pageReceived = false,
    refreshReceived = false,
    settled = false
  await page.route(`**${f.listPath}?*`, async (route) => {
    if (new URL(route.request().url()).searchParams.has('cursor')) {
      pageReceived = true
      await paging
      await route
        .fulfill({ status: 503, json: { message: '旧分页失败，不应显示' } })
        .catch(() => {})
      settled = true
      return
    }
    refreshReceived = true
    await refreshing
    await route.continue()
  })
  try {
    await f.more.click()
    await expect.poll(() => pageReceived).toBe(true)
    await article(page, f.second.name)
      .getByRole('button', { name: `删除检查点 ${f.second.name}`, exact: true })
      .click()
    await page
      .getByRole('dialog', { name: `删除检查点「${f.second.name}」？`, exact: true })
      .getByRole('button', { name: '删除检查点', exact: true })
      .click()
    await expect.poll(() => refreshReceived).toBe(true)
    await expect(article(page, f.second.name)).toHaveCount(0)
    releasePage()
    await expect.poll(() => settled).toBe(true)
    await frames(page)
    await expect(panel(page).getByRole('button', { name: '刷新', exact: true })).toBeDisabled()
    await expect(panel(page).getByRole('alert')).toHaveCount(0)
    releaseRefresh()
    await expect(panel(page).getByRole('button', { name: '刷新', exact: true })).toBeEnabled()
    await expect(panel(page).getByRole('article')).toHaveCount(50)
    await expect(article(page, f.first.name)).toHaveCount(1)
  } finally {
    releasePage()
    releaseRefresh()
  }
})

test('分页等待时关闭窗口，重开后的列表不被旧页污染且仍可正常加载更多', async ({ page }) => {
  const f = await fixture(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let reads = 0,
    received = false,
    settled = false
  await page.route(`**${f.listPath}?*`, async (route) => {
    if (!new URL(route.request().url()).searchParams.has('cursor')) return route.continue()
    reads++
    if (reads !== 1) return route.continue()
    const response = await route.fetch()
    received = true
    await pending
    await route.fulfill({ response }).catch(() => {})
    settled = true
  })
  try {
    await f.more.click()
    await expect.poll(() => received).toBe(true)
    await expect(
      panel(page).getByRole('button', { name: '正在加载更多…', exact: true }),
    ).toBeDisabled()
    await panel(page).getByRole('button', { name: '关闭', exact: true }).click()
    await expect(panel(page)).toHaveCount(0)
    await page.getByRole('button', { name: '检查点', exact: true }).click()
    await expect(panel(page).getByRole('article')).toHaveCount(50)
    await expect(f.more).toBeEnabled()
    release()
    await expect.poll(() => settled).toBe(true)
    await frames(page)
    await expect(panel(page).getByRole('article')).toHaveCount(50)
    await f.more.click()
    await expect(panel(page).getByRole('article')).toHaveCount(51)
    expect(reads).toBe(2)
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
  } finally {
    release()
  }
})
