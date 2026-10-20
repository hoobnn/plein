import { openCanvasSettings } from './settings-ui'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

const endpoint = '/api/plugins/local/acme/echo'
test.beforeAll(() => {
  execFileSync(process.execPath, [
    join(import.meta.dirname, '../examples/plugins/acme-echo/build.mjs'),
    join(process.env.PLEIN_E2E_DATA!, 'plugins/acme-echo'),
  ])
})
test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/plugins/local/rescan')).ok()).toBe(true)
  expect((await request.put(endpoint, { data: { enabled: false } })).ok()).toBe(true)
})
test.afterEach(async ({ request }) => {
  await request.put(endpoint, { data: { enabled: false } })
})

for (const action of ['scan', 'enable', 'disable', 'reload'] as const) {
  test(`本机插件 ${action} 失败可重试，状态与节点目录一致`, async ({ page, request }) => {
    const initiallyEnabled = action === 'disable' || action === 'reload'
    if (initiallyEnabled)
      expect((await request.put(endpoint, { data: { enabled: true } })).ok()).toBe(true)
    await newProject(page)
    await openCanvasSettings(page)
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: /^插件/ }).click()
    const row = settings.locator('[data-plugin="acme/echo"]')
    const toggle = row.getByRole('switch', { name: '启用 Acme 回声', exact: true })
    await expect(toggle).toBeChecked({ checked: initiallyEnabled })
    let failing = true
    const path =
      action === 'scan'
        ? '/api/plugins/local/rescan'
        : action === 'reload'
          ? `${endpoint}/reload`
          : endpoint
    await page.route(`**${path}`, async (route) => {
      if (failing && route.request().method() !== 'GET')
        await route.fulfill({
          status: 503,
          json: { error: 'test_failure', message: '插件操作暂时失败' },
        })
      else await route.continue()
    })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const button =
      action === 'scan'
        ? settings.getByRole('button', { name: '重新扫描', exact: true })
        : action === 'reload'
          ? row.getByRole('button', { name: '重新加载', exact: true })
          : toggle
    await button.click()
    await expect(settings.getByRole('alert')).toContainText('插件操作暂时失败')
    await expect(button).toBeEnabled()
    await expect(toggle).toBeChecked({ checked: initiallyEnabled })
    failing = false
    await button.click()
    await expect(button).toBeEnabled()
    await expect(settings.getByRole('alert')).toHaveCount(0)
    const enabled = action === 'enable' || action === 'reload'
    await expect(toggle).toBeChecked({ checked: enabled })
    await expect(row).toContainText(enabled ? '已加载' : '未启用')
    const list = await (await request.get('/api/plugins/local')).json()
    expect(list.find((plugin: { id: string }) => plugin.id === 'acme/echo').enabled).toBe(enabled)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '添加节点', exact: true }).click()
    const picker = page.getByRole('dialog', { name: '添加节点', exact: true })
    await picker.getByRole('textbox', { name: '搜索节点', exact: true }).fill('大声说')
    await expect(picker.getByRole('option', { name: '大声说', exact: true })).toHaveCount(
      enabled ? 1 : 0,
    )
    expect(errors).toEqual([])
  })
}

test('插件列表读取失败有反馈，重试恢复真实列表', async ({ page }) => {
  let failing = true
  await page.route('**/api/plugins/local', async (route) => {
    if (failing)
      await route.fulfill({ status: 503, json: { error: 'test_failure', message: '列表暂不可用' } })
    else await route.continue()
  })
  await newProject(page)
  await openCanvasSettings(page)
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: /^插件/ }).click()
  await expect(settings.getByRole('alert')).toContainText('列表暂不可用')
  failing = false
  await settings.getByRole('button', { name: '重试读取插件', exact: true }).click()
  await expect(settings.locator('[data-plugin="acme/echo"]')).toContainText('未启用')
  await expect(settings.getByRole('alert')).toHaveCount(0)
  await settings.screenshot({
    path: test.info().outputPath('plugins-recovered.png'),
    animations: 'disabled',
  })
})

test('刷新读取失败保留现有插件列表，重试后清除过期提示', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 560 })
  await newProject(page)
  await openCanvasSettings(page)
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: /^插件/ }).click()
  const row = settings.locator('[data-plugin="acme/echo"]')
  await expect(row).toContainText('未启用')
  let failing = true
  await page.route('**/api/plugins/local', async (route) => {
    if (failing)
      await route.fulfill({
        status: 503,
        json: { error: 'test_failure', message: '刷新读取暂不可用' },
      })
    else await route.continue()
  })
  await settings.getByRole('button', { name: '重新扫描', exact: true }).click()
  await expect(settings.getByRole('alert')).toContainText('刷新读取暂不可用')
  await expect(row).toContainText('未启用')
  await expect(settings.getByText(/还没有本机插件/)).toHaveCount(0)
  await settings.getByRole('alert').scrollIntoViewIfNeeded()
  await settings.screenshot({
    path: test.info().outputPath('plugin-refresh-error.png'),
    animations: 'disabled',
  })
  failing = false
  await settings.getByRole('button', { name: '重试读取插件', exact: true }).click()
  await expect(settings.getByRole('alert')).toHaveCount(0)
  await expect(row).toContainText('未启用')
})
