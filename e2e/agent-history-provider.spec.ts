import { expect, test } from './fixtures'
import type { AgentSession } from '../packages/protocol/src/agent'
import { newProject } from './canvas'

test('不同智能体的历史续聊发送到原会话，新对话使用默认智能体', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('plein:agent', 'builtin'))
  await page.route('**/api/agent', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        agents: [
          { id: 'builtin', name: '内置测试智能体', available: true },
          { id: 'codex', name: 'Codex', available: true },
        ],
      },
    }),
  )
  await newProject(page)
  const canvas = new URL(page.url()).hash.split('/').at(-1)!
  const response = await page.request.post(`/api/canvases/${canvas}/agent/sessions`, {
    data: { agent: 'builtin' },
  })
  expect(response.ok()).toBe(true)
  const history = (await response.json()) as AgentSession
  history.agent = 'codex'
  history.title = 'Codex 历史会话'
  history.items = [{ id: 'old-text', type: 'text', text: '原来的讨论', at: Date.now() }]
  const created: string[] = []
  await page.route(`**/api/canvases/${canvas}/agent/sessions`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [history] })
    created.push((route.request().postDataJSON() as { agent: string }).agent)
    return route.continue()
  })
  await page.route(`**/api/agent/sessions/${history.id}`, (route) =>
    route.fulfill({ json: history }),
  )
  await page.route(`**/api/agent/sessions/${history.id}/events`, (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ type: 'session', session: history })}\n\n`,
    }),
  )
  const sent: { id: string; text: string }[] = []
  await page.route('**/api/agent/sessions/*/messages', (route) => {
    sent.push({
      id: route.request().url().split('/').at(-2)!,
      text: (route.request().postDataJSON() as { text: string }).text,
    })
    return route.fulfill({ status: 204 })
  })
  await page.reload()
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const agent = panel.getByRole('combobox', { name: '使用的智能体', exact: true })
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  const send = panel.getByRole('button', { name: '发送', exact: true })
  await expect(agent).toHaveText('Codex')
  await expect(panel.getByText('原来的讨论', { exact: true })).toBeVisible()
  await input.fill('继续刚才的讨论')
  await send.click()
  await expect.poll(() => sent).toEqual([{ id: history.id, text: '继续刚才的讨论' }])
  expect(created).toEqual([])
  await expect(agent).toHaveText('Codex')
  await panel.getByRole('button', { name: '新对话', exact: true }).click()
  await expect(agent).toHaveText('内置测试智能体')
  await input.fill('另开一段')
  await send.click()
  await expect.poll(() => sent.length).toBe(2)
  expect(created).toEqual(['builtin'])
  expect(sent[1]!.id).not.toBe(history.id)
  await panel.getByRole('button', { name: '历史对话', exact: true }).click()
  await page
    .getByRole('dialog', { name: '历史对话', exact: true })
    .getByRole('button', { name: /^Codex 历史会话/ })
    .click()
  await expect(agent).toHaveText('Codex')
  await input.fill('再次回到原来的讨论')
  await send.click()
  await expect.poll(() => sent.length).toBe(3)
  expect(sent[2]).toEqual({ id: history.id, text: '再次回到原来的讨论' })
  expect(created).toEqual(['builtin'])
  await input.fill('切换后另开一段')
  await agent.click()
  await page.getByRole('option', { name: '内置测试智能体', exact: true }).click()
  await expect(agent).toHaveText('内置测试智能体')
  await expect(panel.getByText('原来的讨论', { exact: true })).toHaveCount(0)
  await expect(input).toHaveValue('切换后另开一段')
  await send.click()
  await expect.poll(() => sent.length).toBe(4)
  expect(created).toEqual(['builtin', 'builtin'])
  expect(sent[3]!.id).not.toBe(history.id)
  expect(sent[3]!.id).not.toBe(sent[1]!.id)
  await page.screenshot({
    path: test.info().outputPath('history-provider.png'),
    animations: 'disabled',
  })
})
