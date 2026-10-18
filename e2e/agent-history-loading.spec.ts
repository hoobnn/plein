import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

async function seed(page: Page) {
  await newProject(page)
  const canvas = new URL(page.url()).hash.split('/').at(-1)!
  const created = await page.request.post(`/api/canvases/${canvas}/agent/sessions`, {
    data: { agent: 'builtin' },
  })
  expect(created.ok()).toBe(true)
  const { id } = (await created.json()) as { id: string }
  await page.request.post(`/api/agent/sessions/${id}/messages`, {
    data: { text: '已有讨论', approval: 'auto' },
  })
  await expect
    .poll(
      async () =>
        ((await (await page.request.get(`/api/agent/sessions/${id}`)).json()) as { status: string })
          .status,
    )
    .toBe('idle')
  const sent: string[] = []
  await page.route('**/api/agent/sessions/*/messages', (route) => {
    sent.push(route.request().url().split('/').at(-2)!)
    return route.fulfill({ status: 204 })
  })
  return { canvas, id, sent }
}

test('首次历史读取期间禁用发送，恢复原会话后保留草稿并准确续聊', async ({ page }) => {
  const { canvas, id, sent } = await seed(page)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/api/canvases/${canvas}/agent/sessions`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    await gate
    await route.fulfill({ response })
  })
  await page.reload()
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await input.fill('等待期间的草稿')
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
  await input.press('Enter')
  expect(sent).toEqual([])
  await expect(panel.getByRole('status')).toHaveText('正在读取历史对话…')
  release()
  await expect(panel.getByText('【mock】看过画布了：已有讨论', { exact: true })).toBeVisible()
  await expect(input).toHaveValue('等待期间的草稿')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => sent).toEqual([id])
})

for (const recovery of ['重新读取', '开始新对话'] as const) {
  test(`首次历史读取失败后可${recovery}，草稿保留且不自动发送`, async ({ page }) => {
    const { canvas, id, sent } = await seed(page)
    let requests = 0
    await page.route(`**/api/canvases/${canvas}/agent/sessions`, (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      requests++
      if (requests === 1)
        return route.fulfill({
          status: 503,
          json: { error: 'history_failed', message: '历史读取测试失败' },
        })
      return route.continue()
    })
    await page.reload()
    await page.getByRole('button', { name: '打开助手', exact: true }).click()
    const panel = page.getByRole('complementary', { name: '助手', exact: true })
    const input = panel.getByPlaceholder('让小满帮你做点什么…')
    await expect(panel.getByRole('alert')).toContainText('历史读取测试失败')
    await input.fill('失败后保留的草稿')
    await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    await input.press('Enter')
    expect(sent).toEqual([])
    await page.screenshot({
      path: test.info().outputPath('history-load-error.png'),
      animations: 'disabled',
    })
    await panel.getByRole('button', { name: recovery, exact: true }).click()
    if (recovery === '重新读取') {
      await expect(panel.getByText('【mock】看过画布了：已有讨论', { exact: true })).toBeVisible()
      expect(requests).toBe(2)
    } else {
      await expect(panel.getByText('【mock】看过画布了：已有讨论', { exact: true })).toHaveCount(0)
      expect(requests).toBe(1)
    }
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await expect(input).toHaveValue('失败后保留的草稿')
    await expect(input).toBeFocused()
    expect(sent).toEqual([])
    await panel.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => sent.length).toBe(1)
    if (recovery === '重新读取') expect(sent[0]).toBe(id)
    else expect(sent[0]).not.toBe(id)
    await page.screenshot({
      path: test.info().outputPath('history-recovered.png'),
      animations: 'disabled',
    })
  })
}
