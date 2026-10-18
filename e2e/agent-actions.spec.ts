import { expect, test } from '@playwright/test'
import { elements, newProject } from './canvas'

test('撤销失败保留改动，等待重试时关闭重开仍禁止重复撤销，成功后恢复画布', async ({ page }) => {
  await newProject(page)
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await input.fill('画一张雨夜天台')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect(panel.getByText('【mock】好了')).toBeVisible()
  const undo = panel.getByRole('button', { name: '撤销这一轮', exact: true })
  await expect(undo).toBeEnabled()
  const count = (await elements(page)).length
  expect(count).toBeGreaterThan(0)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let requests = 0
  await page.route('**/agent/sessions/*/turns/*/undo', async (route) => {
    requests++
    if (requests === 1)
      return route.fulfill({
        status: 503,
        json: { error: 'undo_failed', message: '本轮撤销测试失败' },
      })
    await gate
    await route.continue()
  })
  await undo.click()
  await expect(panel.getByRole('alert')).toHaveText('本轮撤销测试失败')
  expect((await elements(page)).length).toBe(count)
  await expect(undo).toBeEnabled()
  await undo.click()
  await expect(undo).toBeDisabled()
  await input.press('Escape')
  await expect(panel).toHaveCount(0)
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  await expect(undo).toBeDisabled()
  await expect(undo).toHaveAttribute('aria-busy', 'true')
  await expect(undo).toHaveText('正在撤销…')
  expect(requests).toBe(2)
  release()
  await expect(panel.getByText(/已撤销：/)).toBeVisible()
  await expect.poll(async () => (await elements(page)).length).toBe(0)
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await page.screenshot({
    path: test.info().outputPath('agent-undo-restored.png'),
    animations: 'disabled',
  })
})

test('停止请求有等待反馈，失败显示错误并允许手动再试', async ({ page }) => {
  await newProject(page)
  const canvas = new URL(page.url()).hash.split('/').at(-1)!
  const created = await page.request.post(`/api/canvases/${canvas}/agent/sessions`, {
    data: { agent: 'builtin' },
  })
  const session = (await created.json()) as { id: string; status: string }
  session.status = 'running'
  await page.route(`**/api/agent/sessions/${session.id}`, (route) =>
    route.fulfill({ json: session }),
  )
  await page.route(`**/api/agent/sessions/${session.id}/events`, (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ type: 'session', session })}\n\n`,
    }),
  )
  await page.reload()
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const stop = panel.getByRole('button', { name: '停止', exact: true })
  await expect(stop).toBeEnabled()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let requests = 0
  await page.route(`**/api/agent/sessions/${session.id}/stop`, async (route) => {
    requests++
    if (requests === 1) {
      await gate
      return route.fulfill({ status: 503, json: { error: 'stop_failed', message: '停止测试失败' } })
    }
    await route.fulfill({ status: 204 })
  })
  await stop.click()
  await expect(stop).toBeDisabled()
  await expect(panel.getByRole('status')).toHaveText('正在停止…')
  release()
  await expect(panel.getByRole('alert')).toHaveText('停止测试失败')
  await expect(stop).toBeEnabled()
  await stop.click()
  await expect(stop).toHaveAttribute('aria-busy', 'false')
  await expect(panel.getByRole('alert')).toHaveCount(0)
  expect(requests).toBe(2)
})
