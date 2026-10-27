import { expect, test } from './fixtures'
import { newProject } from './canvas'

test('历史内置会话正确标识，切换中禁止误发，删除后迟到应答不恢复会话', async ({ page }) => {
  await newProject(page)
  const canvas = new URL(page.url()).hash.split('/').at(-1)!
  const ids: string[] = []
  for (const title of ['第一段历史', '第二段历史']) {
    const created = await page.request.post(`/api/canvases/${canvas}/agent/sessions`, {
      data: { agent: 'builtin' },
    })
    expect(created.ok()).toBe(true)
    const { id } = (await created.json()) as { id: string }
    ids.push(id)
    const sent = await page.request.post(`/api/agent/sessions/${id}/messages`, {
      data: { text: title, approval: 'auto' },
    })
    expect(sent.ok()).toBe(true)
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
  await page.reload()
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await expect(input).toBeFocused()
  await input.fill('切换期间仍然保留的草稿')
  const historyButton = panel.getByRole('button', { name: '历史对话', exact: true })
  await historyButton.click()
  const history = page.getByRole('dialog', { name: '历史对话', exact: true })
  await expect(history.getByText(/内置智能体/)).toHaveCount(2)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/api/agent/sessions/${ids[0]}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    await gate
    await route.fulfill({ response })
  })
  await history.getByRole('button', { name: /^第一段历史/ }).click()
  await expect(panel.getByRole('status')).toHaveText('正在打开对话…')
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
  await input.press('Enter')
  await expect(input).toHaveValue('切换期间仍然保留的草稿')
  await historyButton.click()
  await history.getByRole('button', { name: '删除对话：第一段历史', exact: true }).click()
  await expect(history.getByRole('button', { name: /^第一段历史/ })).toHaveCount(0)
  const late = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/agent/sessions/${ids[0]}`) &&
      response.request().method() === 'GET',
  )
  release()
  await (await late).finished()
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
  await expect(history.getByRole('button', { name: /^第二段历史/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(panel.getByRole('status')).toHaveCount(0)
  await history.getByRole('button', { name: '删除对话：第二段历史', exact: true }).click()
  await expect(history).toHaveCount(0)
  await expect(historyButton).toBeDisabled()
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('切换期间仍然保留的草稿')
  await page.screenshot({
    path: test.info().outputPath('history-removed-draft-kept.png'),
    animations: 'disabled',
  })
})
