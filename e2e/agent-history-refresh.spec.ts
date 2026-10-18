import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

test('删除会话后迟到的列表快照不恢复历史入口，草稿保留且服务端确实删除', async ({ page }) => {
  await newProject(page)
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await input.fill('你好')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect(panel.getByText('【mock】看过画布了：你好', { exact: true })).toBeVisible()
  const historyButton = panel.getByRole('button', { name: '历史对话', exact: true })
  await expect(historyButton).toBeEnabled()
  const canvas = new URL(page.url()).hash.split('/').at(-1)!
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const snapshots: string[][] = []
  await page.route(`**/api/canvases/${canvas}/agent/sessions`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    snapshots.push(((await response.json()) as { id: string }[]).map((s) => s.id))
    await gate
    await route.fulfill({ response })
  })
  await input.fill('更新讨论')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect(panel.getByText('【mock】看过画布了：更新讨论', { exact: true })).toBeVisible()
  await expect.poll(() => snapshots.length).toBeGreaterThan(0)
  const id = snapshots[0]![0]!
  await input.fill('删除后仍保留的草稿')
  await historyButton.click()
  const history = page.getByRole('dialog', { name: '历史对话', exact: true })
  await history.getByRole('button', { name: /^删除对话：/ }).click()
  await expect(historyButton).toBeDisabled()
  await expect(history).toHaveCount(0)
  await expect(input).toHaveValue('删除后仍保留的草稿')
  expect((await page.request.get(`/api/agent/sessions/${id}`)).status()).toBe(404)
  release()
  // 等所有已开始的列表响应结束，不假设一次发送恰好触发几次刷新。
  await page.unrouteAll({ behavior: 'wait' })
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
  await expect(historyButton).toBeDisabled()
  await expect(input).toHaveValue('删除后仍保留的草稿')
  await expect(panel.getByText('【mock】看过画布了：你好', { exact: true })).toHaveCount(0)
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await page.screenshot({
    path: test.info().outputPath('deleted-history.png'),
    animations: 'disabled',
  })
})
