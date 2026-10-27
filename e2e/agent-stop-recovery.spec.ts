import { expect, test } from './fixtures'
import type { AgentSession, AgentSessionSummary } from '../packages/protocol/src/agent'
import { elements, newProject, waitEngine } from './canvas'

test('停止待确认对话后刷新恢复中性状态，续聊不重跑旧任务', async ({ page }) => {
  await newProject(page)
  const canvas = new URL(page.url()).hash.split('/').at(-1)!
  const open = page.getByRole('button', { name: '打开助手', exact: true })
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await open.click()
  await panel.getByRole('combobox', { name: '确认方式', exact: true }).click()
  await page.getByRole('option', { name: '每次运行和删除都先问我', exact: true }).click()
  await input.fill('画一张雨夜天台')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect(panel.getByRole('button', { name: '允许', exact: true })).toBeEnabled()
  const node = (await elements(page)).find((e) => e.nodeType === 'plein/image')!
  await panel.getByRole('button', { name: '停止', exact: true }).click()
  await expect(panel.getByText('本轮对话已停止', { exact: true })).toBeVisible()
  const sessions = (await (
    await page.request.get(`/api/canvases/${canvas}/agent/sessions`)
  ).json()) as AgentSessionSummary[]
  const id = sessions[0]!.id
  const stopped = (await (
    await page.request.get(`/api/agent/sessions/${id}`)
  ).json()) as AgentSession
  expect(stopped.lastTurn).toMatchObject({ state: 'stopped', reason: 'user_stopped' })
  expect(stopped.items).toContainEqual(expect.objectContaining({ type: 'notice', text: '已停止' }))
  expect(stopped.items.some((item) => item.type === 'error')).toBe(false)
  expect(stopped.items).toContainEqual(
    expect.objectContaining({ type: 'tool', name: 'await_approval', status: 'stopped' }),
  )
  await page.reload()
  await waitEngine(page)
  await open.click()
  await expect(panel.getByText('本轮对话已停止', { exact: true })).toBeVisible()
  await expect(panel.getByRole('status').filter({ hasText: /^已停止$/ })).toBeVisible()
  await expect(panel.locator('[data-tool-status="stopped"]')).toHaveCount(1)
  await expect(panel.locator('[data-tool-status="running"]')).toHaveCount(0)
  await expect(panel.locator('.bg-danger-soft')).toHaveCount(0)
  await expect(panel.getByText(/已过期：/)).toBeVisible()
  await input.fill('你好')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect(panel.getByText('【mock】看过画布了：你好', { exact: true })).toBeVisible()
  await expect(panel.getByText('本轮对话已停止', { exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '允许', exact: true })).toHaveCount(0)
  await expect(panel.locator('.bg-danger-soft')).toHaveCount(0)
  expect((await elements(page)).map((e) => ({ id: e.id, results: e.results }))).toEqual([
    { id: node.id, results: 0 },
  ])
  const resumed = (await (
    await page.request.get(`/api/agent/sessions/${id}`)
  ).json()) as AgentSession
  expect(resumed.lastTurn).toMatchObject({ state: 'completed' })
  expect(resumed.lastTurn!.id).not.toBe(stopped.lastTurn!.id)
  await page.screenshot({ path: test.info().outputPath('resumed.png'), animations: 'disabled' })
})

test('旧版停止记录使用中性提示，真正的历史错误继续显示失败', async ({ page }) => {
  await newProject(page)
  const canvas = new URL(page.url()).hash.split('/').at(-1)!
  const response = await page.request.post(`/api/canvases/${canvas}/agent/sessions`, {
    data: { agent: 'builtin' },
  })
  expect(response.ok()).toBe(true)
  const session = (await response.json()) as AgentSession
  session.items = [
    { id: 'legacy-stop', type: 'error', text: '已停止', at: Date.now() },
    { id: 'real-error', type: 'error', text: '平台执行失败，请核对任务', at: Date.now() },
  ]
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
  await expect(panel.getByRole('status').filter({ hasText: /^已停止$/ })).toBeVisible()
  await expect(panel.locator('.bg-danger-soft')).toHaveCount(1)
  await expect(panel.locator('.bg-danger-soft')).toHaveText('平台执行失败，请核对任务')
  await page.screenshot({
    path: test.info().outputPath('legacy-error.png'),
    animations: 'disabled',
  })
})
