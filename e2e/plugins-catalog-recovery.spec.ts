import { openCanvasSettings } from './settings-ui'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { addNode, elements, newProject, waitNode } from './canvas'

const endpoint = '/api/plugins/local/acme/echo'
test.beforeAll(() => {
  execFileSync(process.execPath, [
    join(import.meta.dirname, '../examples/plugins/acme-echo/build.mjs'),
    join(process.env.PLEIN_E2E_DATA!, 'plugins/acme-echo'),
  ])
})
test.beforeEach(async ({ request }) => {
  await request.post('/api/plugins/local/rescan')
  await request.put(endpoint, { data: { enabled: false } })
})
test.afterEach(async ({ request }) => {
  await request.put(endpoint, { data: { enabled: false } })
})

for (const source of ['local', 'external'] as const) {
  test(`插件 ${source} 启用成功但目录读取失败时可单独重试`, async ({ page, request }) => {
    await page.setViewportSize({ width: 800, height: 560 })
    await newProject(page)
    await openCanvasSettings(page)
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: /^插件/ }).click()
    const row = settings.locator('[data-plugin="acme/echo"]')
    const toggle = row.getByRole('switch')
    await expect(toggle).not.toBeChecked()
    let failing = true
    let hold = false
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let mutationCount = 0
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().endsWith(endpoint)) mutationCount++
    })
    await page.route('**/api/catalog', async (route) => {
      if (failing)
        await route.fulfill({
          status: 503,
          json: { error: 'test_failure', message: '节点目录暂不可用' },
        })
      else {
        if (hold) await gate
        await route.continue()
      }
    })
    if (source === 'local') await toggle.click()
    else expect((await request.put(endpoint, { data: { enabled: true } })).ok()).toBe(true)
    await expect(row).toContainText('已加载')
    await expect(toggle).toBeChecked()
    await expect(settings.getByRole('alert')).toContainText('节点目录暂不可用')
    await expect(
      settings.getByRole('button', { name: '重试更新节点目录', exact: true }),
    ).toBeEnabled()
    expect(
      (await (await request.get('/api/catalog')).json()).nodes.some(
        (node: { type: string }) => node.type === 'acme/shout',
      ),
    ).toBe(true)
    await expect(settings.getByRole('alert')).toBeInViewport()
    await settings.screenshot({
      path: test.info().outputPath('catalog-sync-failed.png'),
      animations: 'disabled',
    })
    const failedRetry = page.waitForResponse(
      (response) => response.url().endsWith('/api/catalog') && response.status() === 503,
    )
    await settings.getByRole('button', { name: '重试更新节点目录', exact: true }).click()
    await failedRetry
    await expect(
      settings.getByRole('button', { name: '重试更新节点目录', exact: true }),
    ).toBeEnabled()
    await expect(row).toContainText('已加载')
    failing = false
    hold = true
    await settings.getByRole('button', { name: '重试更新节点目录', exact: true }).click()
    try {
      await expect(
        settings.getByRole('button', { name: '正在更新目录…', exact: true }),
      ).toBeDisabled()
      await expect(toggle).toBeDisabled()
      await expect(row.getByRole('button', { name: '重新加载', exact: true })).toBeDisabled()
    } finally {
      release()
    }
    await expect(settings.getByRole('alert')).toHaveCount(0)
    expect(mutationCount).toBe(source === 'local' ? 1 : 0)
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1440, height: 900 })
    await addNode(page, '大声说')
    const node = (await elements(page)).find((element) => element.nodeType === 'acme/shout')!
    await page
      .getByTestId('generator')
      .getByRole('textbox', { name: '提示词', exact: true })
      .fill('catalog recovered')
    await page.getByTestId('generator').getByRole('button', { name: '生成', exact: true }).click()
    await waitNode(page, node.id)
    await expect(page.getByText('CATALOG RECOVERED!', { exact: true })).toBeVisible()
  })
}
