import { expect, test } from './fixtures'
import type { JobInfo } from '../packages/protocol/src/runs'
import { newProject } from './canvas'

test('首次任务读取失败可直接重试，等待时关闭重开不重复读取，恢复后明确空列表', async ({ page }) => {
  await newProject(page)
  let phase: 'fail' | 'hold' | 'okay' = 'fail'
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let requests = 0
  await page.route('**/api/canvases/*/jobs', async (route) => {
    requests++
    if (phase === 'fail')
      return route.fulfill({
        status: 503,
        json: { error: 'jobs_failed', message: '任务列表测试失败' },
      })
    if (phase === 'hold') await gate
    return route.continue()
  })
  const toolbar = page.getByRole('button', { name: '任务', exact: true })
  await toolbar.click()
  const panel = page.getByRole('complementary', { name: '任务', exact: true })
  await expect(panel.getByText('读取任务失败：任务列表测试失败', { exact: true })).toBeVisible()
  await expect(panel.getByText('还没有运行过节点', { exact: true })).toHaveCount(0)
  const retry = panel.getByRole('button', { name: '重新读取', exact: true })
  phase = 'hold'
  const count = requests
  await retry.evaluate((button) => {
    ;(button as HTMLButtonElement).click()
    ;(button as HTMLButtonElement).click()
  })
  await expect.poll(() => requests).toBe(count + 1)
  const refresh = panel.getByRole('button', { name: '刷新任务', exact: true })
  await expect(refresh).toBeDisabled()
  await expect(refresh).toHaveAttribute('aria-busy', 'true')
  await expect(panel.getByRole('status')).toHaveText('加载任务中…')
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  await toolbar.click()
  await expect(refresh).toBeDisabled()
  expect(requests).toBe(count + 1)
  phase = 'okay'
  release()
  await expect(panel.getByText('还没有运行过节点', { exact: true })).toBeVisible()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '刷新任务', exact: true })).toBeEnabled()
  await page.screenshot({
    path: test.info().outputPath('jobs-empty-recovered.png'),
    animations: 'disabled',
  })
})

test('已有任务刷新失败保留旧列表并说明状态未更新，重试后展示最新任务', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '读取恢复任务',
      params: {},
      x: 300,
      y: 200,
    }),
  )
  const job: JobInfo = {
    id: 'jobs-read-fixture',
    nodeId: id,
    nodeType: 'plein/image',
    status: 'queued',
    attempts: 1,
    createdAt: Date.now(),
  }
  let phase: 'okay' | 'fail' | 'hold' = 'okay'
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/canvases/*/jobs', async (route) => {
    if (phase === 'fail')
      return route.fulfill({
        status: 503,
        json: { error: 'jobs_failed', message: '任务刷新测试失败' },
      })
    if (phase === 'hold') await gate
    return route.fulfill({ json: { jobs: [job], groups: [] } })
  })
  const toolbar = page.getByRole('button', { name: '任务', exact: true })
  const panel = page.getByRole('complementary', { name: '任务', exact: true })
  await toolbar.click()
  const row = panel.getByRole('button', { name: '读取恢复任务', exact: true })
  await expect(row).toBeVisible()
  phase = 'fail'
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  await toolbar.click()
  await expect(panel.getByRole('alert')).toContainText('以下仍为上次读取的任务状态')
  await expect(panel.getByRole('alert')).toContainText('任务刷新测试失败')
  await expect(row).toBeVisible()
  phase = 'hold'
  await panel.getByRole('button', { name: '重新读取', exact: true }).click()
  await expect(row).toBeVisible()
  await expect(panel.getByRole('button', { name: '重新读取', exact: true })).toBeDisabled()
  await page.screenshot({
    path: test.info().outputPath('jobs-stale-retry.png'),
    animations: 'disabled',
  })
  job.status = 'succeeded'
  phase = 'okay'
  release()
  await expect(panel.getByText('已完成', { exact: true })).toBeVisible()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await expect(row).toBeVisible()
  await page.screenshot({
    path: test.info().outputPath('jobs-updated.png'),
    animations: 'disabled',
  })
})
