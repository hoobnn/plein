import { expect, type Page, test } from '@playwright/test'
import type { JobInfo } from '../packages/protocol/src/runs'
import { clickElement, newProject } from './canvas'

async function setup(page: Page) {
  await newProject(page)
  const ids = await page.evaluate(() => {
    const board = window.__plein.addNode({
      type: 'plein/storyboard',
      name: '并发恢复分镜',
      x: 300,
      y: 200,
      params: {
        shots: [
          {
            id: 'pending-shot',
            no: 1,
            duration: 2,
            shotSize: '中景',
            description: '水杯',
            characters: [],
            emotion: '',
            lighting: '',
            sfx: '',
            dialogue: [],
            imagePrompt: '水杯',
            motionPrompt: '固定镜头',
          },
        ],
      },
    })
    const image = window.__plein.addNode({
      type: 'plein/image',
      name: '同一镜头图',
      x: 1000,
      y: 200,
      params: { source: { storyboard: board, shot: 'pending-shot', role: 'image' } },
    })
    return { board, image }
  })
  const job: JobInfo = {
    id: 'pending-recovery',
    nodeId: ids.image,
    nodeType: 'plein/image',
    status: 'failed',
    attempts: 1,
    createdAt: Date.now(),
    recovery: { state: 'fetch_failed', refetchable: true, remoteId: 'remote-kept' },
  }
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const calls: unknown[] = []
  await page.route('**/api/canvases/*/jobs', (route) =>
    route.fulfill({ json: { jobs: [job], groups: [] } }),
  )
  await page.route('**/api/canvases/*/jobs/latest', (route) =>
    route.fulfill({ json: { jobs: [job] } }),
  )
  await page.route('**/api/canvases/*/jobs/pending-recovery/recover', async (route) => {
    calls.push(route.request().postDataJSON())
    if (calls.length === 1) {
      await pending
      return route.fulfill({ status: 503, json: { message: '恢复请求暂时失败' } })
    }
    job.recovery = { state: 'remote_pending', refetchable: true, remoteId: 'remote-kept' }
    await route.fulfill({ json: job })
  })
  await page.getByRole('button', { name: '任务', exact: true }).click()
  return {
    ...ids,
    calls,
    release,
    panel: page.getByRole('complementary', { name: '任务', exact: true }),
  }
}

for (const entry of ['reopen', 'review'] as const) {
  test(`恢复请求进行中 ${entry} 入口同步禁用，失败后可重试且仅提交一次`, async ({ page }) => {
    const f = await setup(page)
    await f.panel.getByRole('button', { name: '重新获取', exact: true }).click()
    await expect.poll(() => f.calls.length).toBe(1)
    let button = f.panel.getByRole('button', { name: '重新获取', exact: true })
    let scope = f.panel as import('@playwright/test').Locator
    try {
      await f.panel.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(f.panel).toHaveCount(0)
      if (entry === 'reopen') await page.getByRole('button', { name: '任务', exact: true }).click()
      else {
        await clickElement(page, f.board)
        await page
          .getByTestId('generator')
          .getByRole('button', { name: /^编辑分镜表/ })
          .click()
        const dialog = page.getByRole('dialog', { name: '分镜表', exact: true })
        await dialog.getByRole('button', { name: '审核镜头', exact: true }).click()
        scope = dialog
          .getByRole('table', { name: '逐镜审核', exact: true })
          .locator('[data-shot-id="pending-shot"]')
        button = scope.getByRole('button', { name: '重新获取', exact: true })
      }
      await expect(button).toBeDisabled()
      await expect(scope.getByRole('status').filter({ hasText: '正在处理恢复请求…' })).toBeVisible()
      if (entry === 'review') {
        await expect(page.getByRole('dialog', { name: '分镜表', exact: true })).toHaveCSS(
          'opacity',
          '1',
        )
        await page.screenshot({ path: 'test-results/recovery-shared-pending.png' })
      }
      expect(f.calls).toHaveLength(1)
    } finally {
      f.release()
    }
    await expect(button).toBeEnabled()
    await button.click()
    await expect(scope.getByText('平台已受理，结果尚未取回', { exact: true })).toBeVisible()
    expect(f.calls).toEqual([{ action: 'refetch' }, { action: 'refetch' }])
  })
}
