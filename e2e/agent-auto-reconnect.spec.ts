import { expect, test } from './fixtures'
import type { AgentSession } from '../packages/protocol/src/agent'
import { newProject, waitEngine } from './canvas'

test('原生自动重试补回断线期间的完成状态，关闭面板有未读提示且历史恢复空闲', async ({ page }) => {
  await newProject(page)
  const canvas = new URL(page.url()).hash.split('/').at(-1)!
  const created = await page.request.post(`/api/canvases/${canvas}/agent/sessions`, {
    data: { agent: 'builtin' },
  })
  const { id } = (await created.json()) as { id: string }
  const read = async () =>
    (await (await page.request.get(`/api/agent/sessions/${id}`)).json()) as AgentSession
  await page.request.post(`/api/agent/sessions/${id}/messages`, {
    data: { text: '画一张雨夜天台', approval: 'always' },
  })
  await expect
    .poll(async () =>
      (await read()).items.some((item) => item.type === 'approval' && item.status === 'pending'),
    )
    .toBe(true)
  const running = await read()
  let requests = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/api/agent/sessions/${id}/events`, async (route) => {
    requests++
    if (requests === 1)
      return route.fulfill({
        contentType: 'text/event-stream',
        body: `retry: 100\ndata: ${JSON.stringify({ type: 'session', session: running })}\n\n`,
      })
    if (requests === 2) return route.abort('failed')
    await gate
    return route.continue()
  })
  const sent: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith(`/api/agent/sessions/${id}/messages`))
      sent.push(request.url())
  })
  await page.reload()
  const open = page.getByRole('button', { name: '打开助手', exact: true })
  await open.click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await expect(panel.getByRole('button', { name: '停止', exact: true })).toBeVisible()
  await input.fill('自动重连保留的草稿')
  await input.press('Escape')
  await expect.poll(() => requests).toBe(3)
  const approval = running.items.find(
    (item) => item.type === 'approval' && item.status === 'pending',
  )!
  expect(
    (
      await page.request.post(`/api/agent/sessions/${id}/approvals/${approval.id}`, {
        data: { allow: false },
      })
    ).ok(),
  ).toBe(true)
  await expect.poll(async () => (await read()).status).toBe('idle')
  release()
  const unread = open.getByRole('img', { name: '助手有新回复', exact: true })
  await expect(open.locator('.bg-accent')).toBeVisible()
  await expect(unread).toBeVisible()
  expect(sent).toEqual([])
  await page.screenshot({
    path: test.info().outputPath('auto-reconnected-unread.png'),
    animations: 'disabled',
  })
  await page.evaluate(() => {
    location.hash = '/'
  })
  const homeTrigger = page
    .getByRole('banner')
    .getByRole('button', { name: '打开助手', exact: true })
  await expect(homeTrigger.getByRole('img', { name: '助手有新回复', exact: true })).toBeVisible()
  await homeTrigger.click()
  await expect(panel).toContainText('打开一块画布，我就能帮你搭工作流')
  await expect(page.getByRole('img', { name: '助手有新回复', exact: true })).toHaveCount(0)
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(homeTrigger).toBeFocused()
  await page.evaluate((canvas) => {
    location.hash = `/c/${canvas}`
  }, canvas)
  await waitEngine(page)
  await open.click()
  await expect(unread).toHaveCount(0)
  await expect(
    panel.getByText('【mock】这次运行没有执行，已保留创建的节点。', { exact: true }),
  ).toBeVisible()
  await expect(panel.getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
  await expect(input).toHaveValue('自动重连保留的草稿')
  await panel.getByRole('button', { name: '历史对话', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '历史对话', exact: true })).not.toContainText(
    '进行中',
  )
  expect(sent).toEqual([])
  await page.screenshot({
    path: test.info().outputPath('auto-reconnected-history.png'),
    animations: 'disabled',
  })
})
