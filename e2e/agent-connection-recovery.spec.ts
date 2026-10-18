import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

test('事件流彻底关闭后可重连，失败可再试，恢复最新状态且不重发消息', async ({ page }) => {
  await newProject(page)
  const canvas = new URL(page.url()).hash.split('/').at(-1)!
  const created = await page.request.post(`/api/canvases/${canvas}/agent/sessions`, {
    data: { agent: 'builtin' },
  })
  const { id } = (await created.json()) as { id: string }
  const message = async (text: string) => {
    expect(
      (
        await page.request.post(`/api/agent/sessions/${id}/messages`, {
          data: { text, approval: 'auto' },
        })
      ).ok(),
    ).toBe(true)
    await expect
      .poll(
        async () =>
          (
            (await (await page.request.get(`/api/agent/sessions/${id}`)).json()) as {
              status: string
            }
          ).status,
      )
      .toBe('idle')
  }
  await message('连接前的讨论')
  let requests = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/api/agent/sessions/${id}/events`, async (route) => {
    requests++
    if (requests <= 2) return route.fulfill({ status: 204 })
    await gate
    return route.continue()
  })
  const sent: string[] = []
  await page.route('**/api/agent/sessions/*/messages', (route) => {
    sent.push(route.request().url().split('/').at(-2)!)
    return route.fulfill({ status: 204 })
  })
  await page.reload()
  const open = page.getByRole('button', { name: '打开助手', exact: true })
  await open.click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  const reconnect = panel.getByRole('button', { name: '重新连接', exact: true })
  await expect(panel.getByRole('alert')).toContainText('连接已断开')
  await input.fill('重连期间保留的草稿')
  await input.press('Escape')
  await open.click()
  await expect(reconnect).toBeEnabled()
  expect(requests).toBe(1)
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
  await input.press('Enter')
  expect(sent).toEqual([])
  await page.screenshot({
    path: test.info().outputPath('connection-closed.png'),
    animations: 'disabled',
  })
  await reconnect.click()
  await expect.poll(() => requests).toBe(2)
  await expect(panel.getByRole('alert')).toContainText('连接已断开')
  await expect(reconnect).toBeEnabled()
  await message('断线期间的新回复')
  await expect(
    panel.getByText('【mock】看过画布了：断线期间的新回复', { exact: true }),
  ).toHaveCount(0)
  await reconnect.click()
  await expect(reconnect).toBeDisabled()
  await expect(reconnect).toHaveAttribute('aria-busy', 'true')
  await input.press('Escape')
  await open.click()
  await expect(reconnect).toBeDisabled()
  await expect(panel.getByRole('status')).toContainText('正在重新连接')
  await page.screenshot({
    path: test.info().outputPath('connection-pending.png'),
    animations: 'disabled',
  })
  release()
  await expect(
    panel.getByText('【mock】看过画布了：断线期间的新回复', { exact: true }),
  ).toBeVisible()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await expect(reconnect).toHaveCount(0)
  await expect(input).toHaveValue('重连期间保留的草稿')
  expect(sent).toEqual([])
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => sent).toEqual([id])
  await expect(input).toHaveValue('')
  await page.screenshot({ path: test.info().outputPath('reconnected.png'), animations: 'disabled' })
})
