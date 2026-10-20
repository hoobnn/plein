import { expect, test } from '@playwright/test'
import { newProject } from './canvas'
import { openCanvasSettings } from './settings-ui'

for (const method of ['POST', 'DELETE']) {
  test(`对外 MCP ${method} 失败有提示并可恢复，不改变原连接状态`, async ({ page, request }) => {
    await request.delete('/api/mcp/external')
    await newProject(page)
    await openCanvasSettings(page)
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: 'MCP', exact: true }).click()
    if (method === 'DELETE')
      await settings.getByRole('button', { name: '生成连接令牌', exact: true }).click()
    const config = settings.getByTestId('external-mcp-config')
    if (method === 'DELETE') await expect(config).toBeVisible()
    const before = method === 'DELETE' ? await config.textContent() : null
    let failing = true
    await page.route('**/api/mcp/external', async (route) => {
      if (failing && route.request().method() === method)
        await route.fulfill({
          status: 503,
          json: { error: 'test_failure', message: '暂时无法保存连接设置' },
        })
      else await route.continue()
    })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const action = settings
      .getByRole('button', { name: method === 'POST' ? '生成连接令牌' : '关闭', exact: true })
      .last()
    await action.click()
    await expect(settings.getByRole('alert')).toContainText('暂时无法保存连接设置')
    await expect(action).toBeEnabled()
    expect((await (await request.get('/api/mcp/external')).json()).enabled).toBe(
      method === 'DELETE',
    )
    if (before) await expect(config).toHaveText(before)
    failing = false
    await action.click()
    await expect(settings.getByRole('alert')).toHaveCount(0)
    if (method === 'POST') await expect(config).toBeVisible()
    else await expect(config).toHaveCount(0)
    await expect
      .poll(async () => (await (await request.get('/api/mcp/external')).json()).enabled)
      .toBe(method === 'POST')
    expect(errors).toEqual([])
    await request.delete('/api/mcp/external')
  })
}

test('MCP 配置复制失败不显示成功，重试和客户端切换对应实际剪贴板', async ({
  page,
  request,
  context,
}) => {
  await request.delete('/api/mcp/external')
  await page.setViewportSize({ width: 800, height: 560 })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await newProject(page)
  await openCanvasSettings(page)
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: 'MCP', exact: true }).click()
  await settings.getByRole('button', { name: '生成连接令牌', exact: true }).click()
  const config = settings.getByTestId('external-mcp-config')
  await expect(config).toBeVisible()
  await page.evaluate(async () => {
    await navigator.clipboard.writeText('保留的剪贴板')
    const original = navigator.clipboard.writeText.bind(navigator.clipboard)
    let first = true
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async (text: string) => {
        if (first) {
          first = false
          throw new DOMException('Denied', 'NotAllowedError')
        }
        return original(text)
      },
    })
  })
  await settings.getByRole('button', { name: '复制', exact: true }).click()
  await expect(settings.getByRole('alert')).toContainText('复制失败')
  await expect(settings.getByRole('alert')).toBeInViewport()
  await settings.screenshot({
    path: test.info().outputPath('mcp-copy-failed.png'),
    mask: [config],
    animations: 'disabled',
  })
  await expect(settings.getByRole('button', { name: '已复制', exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('保留的剪贴板')
  await settings.getByRole('button', { name: '复制', exact: true }).click()
  await expect(settings.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await config.textContent())
  await settings.getByRole('button', { name: 'Cursor 等', exact: true }).click()
  await expect(settings.getByRole('button', { name: '复制', exact: true })).toBeVisible()
  await settings.getByRole('button', { name: '复制', exact: true }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await config.textContent())
  await expect(settings.getByRole('alert')).toHaveCount(0)
  await settings.screenshot({
    path: test.info().outputPath('mcp-copy-recovered.png'),
    mask: [config],
    animations: 'disabled',
  })
  await request.delete('/api/mcp/external')
})
