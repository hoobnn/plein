import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

test('助手草稿关闭后恢复，发送失败保留，迟到成功不清除新输入', async ({ page }) => {
  await newProject(page)
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  const open = async () => {
    await page.getByRole('button', { name: '打开助手', exact: true }).click()
    await expect(input).toBeFocused()
  }
  await open()
  await input.fill('尚未发送的草稿\n第二行')
  await input.press('Escape')
  await expect(panel).toHaveCount(0)
  await open()
  await expect(input).toHaveValue('尚未发送的草稿\n第二行')
  await page.route('**/agent/sessions', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'draft_test_failed', message: '草稿发送测试失败' }),
    }),
  )
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect(panel.getByText(/草稿发送测试失败/)).toBeVisible()
  await expect(input).toHaveValue('尚未发送的草稿\n第二行')
  await page.unroute('**/agent/sessions')
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let requests = 0
  await page.route('**/agent/sessions/*/messages', async (route) => {
    requests++
    await gate
    await route.fulfill({ status: 204 })
  })
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => requests).toBe(1)
  await expect(panel.getByRole('status')).toHaveText('正在发送…')
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
  await input.press('Enter')
  expect(requests).toBe(1)
  await input.fill('发送等待期间写的新草稿')
  release()
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
  await expect(input).toHaveValue('发送等待期间写的新草稿')
  await input.press('Escape')
  await expect(panel).toHaveCount(0)
  await open()
  await expect(input).toHaveValue('发送等待期间写的新草稿')
  await page.screenshot({
    path: test.info().outputPath('agent-restored-draft.png'),
    animations: 'disabled',
  })
})

test('不同画布的助手草稿隔离，返回原画布恢复原稿', async ({ page }) => {
  await newProject(page)
  const first = new URL(page.url()).hash
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  const input = page
    .getByRole('complementary', { name: '助手', exact: true })
    .getByPlaceholder('让小满帮你做点什么…')
  await expect(input).toBeFocused()
  await input.fill('第一块画布的草稿')
  await page.getByRole('link', { name: 'Plein', exact: true }).click()
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  await expect(page).toHaveURL(/#\/c\//)
  const second = new URL(page.url()).hash
  expect(second).not.toBe(first)
  await expect(input).toHaveValue('')
  await input.fill('第二块画布的草稿')
  await page.evaluate((hash) => {
    location.hash = hash
  }, first)
  await expect(input).toHaveValue('第一块画布的草稿')
  await page.evaluate((hash) => {
    location.hash = hash
  }, second)
  await expect(input).toHaveValue('第二块画布的草稿')
})
