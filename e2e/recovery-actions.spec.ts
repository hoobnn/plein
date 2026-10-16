import { expect, test } from '@playwright/test'
import type { JobInfo } from '../packages/protocol/src/runs'
import { addNode, elements, newProject } from './canvas'

for (const state of [
  'fetch_failed',
  'remote_pending',
  'pending_failed',
  'submit_unknown',
  'review',
  'remote_failed',
  'legacy',
] as const) {
  test(`任务恢复操作：${state} 不混淆重新获取与重新生成`, async ({ page }) => {
    await newProject(page)
    await addNode(page, '生成图片')
    const node = (await elements(page)).find((e) => e.kind === 'node')!
    const job: JobInfo = {
      id: 'recover-fixture',
      nodeId: node.id,
      nodeType: node.nodeType!,
      status: state === 'remote_pending' || state === 'review' ? 'canceled' : 'failed',
      attempts: 1,
      error: '请求没有完成',
      createdAt: Date.now(),
      ...(state === 'legacy'
        ? {}
        : {
            recovery: {
              state: state === 'pending_failed' ? 'remote_pending' : state,
              refetchable:
                state === 'fetch_failed' ||
                state === 'remote_pending' ||
                state === 'pending_failed',
              remoteId: 'remote-existing',
            },
          }),
    }
    const calls: unknown[] = []
    let submissions = 0
    await page.route('**/api/canvases/*/jobs', (route) =>
      route.fulfill({ json: { jobs: [job], groups: [] } }),
    )
    await page.route('**/api/canvases/*/jobs/recover-fixture/recover', async (route) => {
      calls.push(route.request().postDataJSON())
      await route.fulfill({ json: { ok: true } })
    })
    await page.route('**/api/canvases/*/nodes/*/run', async (route) => {
      submissions++
      await route.abort()
    })
    await page.getByRole('button', { name: '任务', exact: true }).click()
    const panel = page.getByRole('complementary', { name: '任务', exact: true })
    await expect(panel.locator('li')).toHaveCount(1)
    if (state === 'remote_failed' || state === 'legacy') {
      await expect(panel.getByRole('button', { name: '重试', exact: true })).toBeVisible()
      await panel.getByRole('button', { name: '重试', exact: true }).click()
      await expect.poll(() => submissions).toBe(1)
      expect(calls).toEqual([])
    } else {
      await expect(panel.getByRole('button', { name: '重试', exact: true })).toHaveCount(0)
      if (state === 'fetch_failed' || state === 'remote_pending' || state === 'pending_failed') {
        await panel.getByRole('button', { name: '重新获取', exact: true }).click()
        await expect.poll(() => calls).toEqual([{ action: 'refetch' }])
        expect(submissions).toBe(0)
      }
      if (state === 'review')
        await expect(panel.getByRole('button', { name: '去审查' })).toBeVisible()
      if (state === 'submit_unknown')
        await expect(panel.getByRole('button', { name: '确认未受理，重新提交' })).toBeVisible()
    }
  })
}
