import { expect, test } from './fixtures'
import type { JobInfo } from '../packages/protocol/src/runs'
import { addNode, elements, newProject } from './canvas'

for (const action of ['attach', 'resubmit'] as const) {
  test(`恢复任务 ${action} 请求失败保留输入与确认，重试成功后清理表单`, async ({ page }) => {
    await newProject(page)
    await addNode(page, '生成图片')
    const node = (await elements(page)).find((el) => el.kind === 'node')!
    const job: JobInfo = {
      id: 'draft-recovery',
      nodeId: node.id,
      nodeType: node.nodeType!,
      status: 'failed',
      attempts: 1,
      error: '提交结果未确认',
      createdAt: Date.now(),
      recovery: {
        state: 'submit_unknown',
        provider: '测试平台',
        attachable: true,
        refetchable: false,
      },
    }
    const requests: unknown[] = []
    let generated = 0
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    await page.route('**/api/canvases/*/jobs', (route) =>
      route.fulfill({ json: { jobs: [job], groups: [] } }),
    )
    await page.route('**/api/canvases/*/nodes/*/run', (route) => {
      generated++
      return route.abort()
    })
    await page.route('**/api/canvases/*/jobs/draft-recovery/recover', async (route) => {
      requests.push(route.request().postDataJSON())
      if (requests.length === 1)
        return route.fulfill({ status: 503, json: { message: '恢复服务暂不可用，请重试' } })
      await pending
      job.recovery = { state: 'remote_pending', refetchable: true, remoteId: 'remote-existing-42' }
      await route.fulfill({ json: job })
    })
    await page.getByRole('button', { name: '任务', exact: true }).click()
    const panel = page.getByRole('complementary', { name: '任务', exact: true })
    const input = panel.getByRole('textbox', { name: '平台任务 ID', exact: true })
    if (action === 'attach') {
      await panel.getByRole('button', { name: '填写平台任务 ID', exact: true }).click()
      await input.fill('  remote-existing-42  ')
    } else await panel.getByRole('button', { name: '确认未受理，重新提交', exact: true }).click()
    const submit = panel.getByRole('button', {
      name: action === 'attach' ? '接着取结果' : '重新提交',
      exact: true,
    })
    await submit.click()
    await expect(page.getByText('恢复服务暂不可用，请重试', { exact: true }).first()).toBeVisible()
    if (action === 'attach') await expect(input).toHaveValue('  remote-existing-42  ')
    else await expect(submit).toBeVisible()
    await expect(panel.getByRole('alert')).toHaveText('恢复服务暂不可用，请重试')
    await page.screenshot({ path: `test-results/recovery-draft-${action}.png` })
    try {
      await submit.click()
      await expect.poll(() => requests.length).toBe(2)
      await expect(submit).toBeDisabled()
      await expect(panel.getByRole('button', { name: '取消', exact: true })).toBeDisabled()
      if (action === 'attach') await expect(input).toBeDisabled()
    } finally {
      finish()
    }
    await expect(panel.getByRole('button', { name: '重新获取', exact: true })).toBeVisible()
    await expect(submit).toHaveCount(0)
    await expect(panel.getByRole('alert')).toHaveCount(0)
    const body = action === 'attach' ? { action, remoteId: 'remote-existing-42' } : { action }
    expect(requests).toEqual([body, body])
    expect(generated).toBe(0)
  })
}
