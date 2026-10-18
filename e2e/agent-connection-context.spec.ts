import { expect, test } from '@playwright/test'
import type { AgentSession } from '../packages/protocol/src/agent'
import { newProject } from './canvas'

for (const destination of ['新对话', '其他历史'] as const) {
  test(`重连等待时转到${destination}，迟到旧流不能恢复原会话或改变发送目标`, async ({ page }) => {
    await newProject(page)
    const canvas = new URL(page.url()).hash.split('/').at(-1)!
    const sessions: AgentSession[] = []
    for (const text of ['其他历史', '原会话']) {
      const created = await page.request.post(`/api/canvases/${canvas}/agent/sessions`, {
        data: { agent: 'builtin' },
      })
      expect(created.ok()).toBe(true)
      const { id } = (await created.json()) as { id: string }
      await page.request.post(`/api/agent/sessions/${id}/messages`, {
        data: { text, approval: 'auto' },
      })
      await expect
        .poll(
          async () =>
            ((await (await page.request.get(`/api/agent/sessions/${id}`)).json()) as AgentSession)
              .status,
        )
        .toBe('idle')
      sessions.push(
        (await (await page.request.get(`/api/agent/sessions/${id}`)).json()) as AgentSession,
      )
    }
    const old = sessions[1]!
    let requests = 0
    let release!: () => void
    let replied = false
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(`**/api/agent/sessions/${old.id}/events`, async (route) => {
      requests++
      if (requests === 1) return route.fulfill({ status: 204 })
      await gate
      await route.fulfill({
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ type: 'session', session: old })}\n\n`,
      })
      replied = true
    })
    const sent: string[] = []
    await page.route('**/api/agent/sessions/*/messages', (route) => {
      sent.push(route.request().url().split('/').at(-2)!)
      return route.fulfill({ status: 204 })
    })
    await page.reload()
    await page.getByRole('button', { name: '打开助手', exact: true }).click()
    const panel = page.getByRole('complementary', { name: '助手', exact: true })
    const input = panel.getByPlaceholder('让小满帮你做点什么…')
    await expect(panel.getByRole('alert')).toContainText('连接已断开')
    await input.fill('重连时的草稿')
    await panel.getByRole('button', { name: '重新连接', exact: true }).click()
    await expect.poll(() => requests).toBe(2)
    await expect(panel.getByRole('status')).toContainText('正在重新连接')
    if (destination === '新对话') {
      await panel.getByRole('button', { name: '新对话', exact: true }).click()
      await expect(panel.getByRole('button', { name: '新对话', exact: true })).toBeDisabled()
    } else {
      await panel.getByRole('button', { name: '历史对话', exact: true }).click()
      await page
        .getByRole('dialog', { name: '历史对话', exact: true })
        .getByRole('button', { name: /^其他历史/ })
        .click()
      await expect(panel.getByText('【mock】看过画布了：其他历史', { exact: true })).toBeVisible()
    }
    await expect(panel.getByRole('button', { name: '重新连接', exact: true })).toHaveCount(0)
    release()
    await expect.poll(() => replied).toBe(true)
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    await expect(panel.getByText('【mock】看过画布了：原会话', { exact: true })).toHaveCount(0)
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await expect(input).toHaveValue('重连时的草稿')
    expect(sent).toEqual([])
    await panel.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => sent.length).toBe(1)
    if (destination === '其他历史') expect(sent[0]).toBe(sessions[0]!.id)
    else expect(sessions.map((s) => s.id)).not.toContain(sent[0])
    await expect(input).toHaveValue('')
    await page.screenshot({
      path: test.info().outputPath('connection-context.png'),
      animations: 'disabled',
    })
  })
}
