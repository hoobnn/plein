import { expect, test } from '@playwright/test'
import type { JobInfo } from '../packages/protocol/src/runs'
import { clickElement, newProject } from './canvas'

for (const entry of ['任务面板重开', '生成面板', '序列导出面板', '画布卡片'] as const) {
  test(`停止请求等待时${entry}共享禁用状态，失败可重试且不重复提交`, async ({ page }) => {
    await newProject(page)
    const sequence = entry === '序列导出面板'
    const id = await page.evaluate((sequence) => {
      const id = window.__plein.addNode({
        type: sequence ? 'plein/sequence' : 'plein/image',
        name: '停止等待测试',
        params: sequence ? {} : { prompt: '透明水杯' },
        x: 300,
        y: 200,
      })
      const node = window.__plein.engine.doc.mutable(id) as unknown as {
        set(key: string, value: unknown): void
      }
      node.set('run', { id: 'cancel-pending-job', status: 'running', at: Date.now() })
      return id
    }, sequence)
    const peer = await page.context().newPage()
    try {
      await peer.goto(page.url())
      await expect
        .poll(() =>
          peer.evaluate(
            (id) =>
              (window.__plein?.engine.doc.get(id) as { run?: { id: string } } | undefined)?.run?.id,
            id,
          ),
        )
        .toBe('cancel-pending-job')
      const job: JobInfo = {
        id: 'cancel-pending-job',
        nodeId: id,
        nodeType: sequence ? 'plein/sequence' : 'plein/image',
        status: 'running',
        attempts: 1,
        createdAt: Date.now(),
      }
      await page.route('**/api/canvases/*/jobs', (route) =>
        route.fulfill({ json: { jobs: [job], groups: [] } }),
      )
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const calls: unknown[] = []
      await page.route(`**/api/canvases/*/nodes/${id}/cancel`, async (route) => {
        calls.push(route.request().postDataJSON())
        if (calls.length === 1) {
          await gate
          return route.fulfill({
            status: 503,
            json: { error: 'cancel_failed', message: '停止任务测试失败' },
          })
        }
        const response = await route.fetch()
        if (response.status() === 204) job.status = 'canceled'
        await route.fulfill({ response })
      })
      await page.getByRole('button', { name: '任务', exact: true }).click()
      const panel = page.getByRole('complementary', { name: '任务', exact: true })
      let stop = panel.getByRole('button', { name: '停止', exact: true })
      await stop.evaluate((button) => {
        ;(button as HTMLButtonElement).click()
        ;(button as HTMLButtonElement).click()
      })
      await expect.poll(() => calls.length).toBe(1)
      await expect(stop).toBeDisabled()
      await panel.getByRole('button', { name: '关闭', exact: true }).click()
      let scope = panel
      if (entry === '任务面板重开')
        await page.getByRole('button', { name: '任务', exact: true }).click()
      else if (entry === '画布卡片') {
        scope = page.locator('.plein-node')
        stop = scope.getByRole('button', { name: '取消生成', exact: true })
      } else {
        await clickElement(page, id)
        if (sequence) {
          const generator = page.getByTestId('generator')
          const expand = generator.getByRole('button', { name: '编辑序列', exact: true })
          if (await expand.isVisible()) await expand.click()
          await generator.getByRole('button', { name: /^编辑序列（/ }).click()
          scope = page.getByRole('dialog', { name: '序列', exact: true })
          stop = scope.getByRole('button', { name: '停止导出', exact: true })
        } else {
          scope = page.getByTestId('generator')
          stop = scope.getByRole('button', { name: '取消', exact: true })
        }
      }
      await expect(stop).toBeDisabled()
      await expect(stop).toHaveAttribute('aria-busy', 'true')
      const waiting =
        entry === '画布卡片'
          ? scope.getByText('正在停止任务…', { exact: true })
          : scope.getByRole('status').filter({ hasText: '正在停止任务…' })
      await expect(waiting).toBeVisible()
      expect(calls).toEqual([{ runId: 'cancel-pending-job' }])
      await page.screenshot({
        path: test.info().outputPath('cancel-pending.png'),
        animations: 'disabled',
      })
      release()
      await expect(page.getByText('停止任务测试失败', { exact: true })).toBeVisible()
      await expect(stop).toBeEnabled()
      await stop.click()
      await expect
        .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.run?.status, id))
        .toBe('canceled')
      await expect(waiting).toHaveCount(0)
      expect(calls).toEqual([{ runId: 'cancel-pending-job' }, { runId: 'cancel-pending-job' }])
    } finally {
      await peer.close()
    }
  })
}
