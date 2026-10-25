import { expect, test } from '@playwright/test'
import type { Catalog } from '../packages/protocol/src/plugins'
import { newProject } from './canvas'
import { openCanvasSettings } from './settings-ui'

const configUrl = '/api/providers/plein/compatible/config'
test.beforeEach(async ({ request }) => {
  expect(
    (
      await request.put(configUrl, {
        data: { enabled: false, settings: {}, secrets: { COMPATIBLE_API_KEY: null } },
      })
    ).ok(),
  ).toBe(true)
})
test.afterEach(async ({ request }) => {
  await request.put(configUrl, {
    data: { enabled: false, settings: {}, secrets: { COMPATIBLE_API_KEY: null } },
  })
})

test('兼容渠道可通过现有设置表单配置，显式能力与模型身份同步更新', async ({ page, request }) => {
  await newProject(page)
  const settings = await openCanvasSettings(page)
  await settings.getByRole('button', { name: /^模型平台/ }).click()
  const row = settings.locator('[data-provider="plein/compatible"]')
  await row.getByRole('button', { expanded: false }).click()
  await row.getByLabel('API Key', { exact: true }).fill('test-only-not-a-real-key')
  await row
    .getByRole('textbox', { name: 'Base URL', exact: true })
    .fill('https://gateway.example.com/v1')
  await row.getByRole('textbox', { name: '模型 ID', exact: true }).fill('example-chat')
  await row.getByRole('checkbox', { name: '支持图片输入', exact: true }).check()
  await row.getByRole('button', { name: '保存', exact: true }).click()
  await expect(row.getByRole('status')).toContainText('已保存')
  await row.getByRole('switch', { name: '启用 兼容对话渠道', exact: true }).click()
  await expect(row.getByRole('switch', { name: '启用 兼容对话渠道', exact: true })).toBeChecked()
  const catalog = (await (await request.get('/api/catalog')).json()) as Catalog
  const provider = catalog.providers.find((p) => p.id === 'plein/compatible')!
  expect(provider.enabled).toBe(true)
  expect(provider.models).toMatchObject([{ title: 'example-chat', features: ['vision'] }])
  const initial = provider.models[0]!.id
  await row.getByRole('button', { name: '检查配置', exact: true }).click()
  await expect(row.getByRole('status')).toContainText('尚未验证远端密钥、模型权限或网络')
  await row.getByRole('textbox', { name: '模型 ID', exact: true }).fill('another-chat')
  await expect(row.getByRole('button', { name: '检查配置', exact: true })).toBeDisabled()
  await row.getByRole('button', { name: '保存', exact: true }).click()
  await expect(row.getByRole('status')).toContainText('已保存')
  const updated = (await (await request.get('/api/catalog')).json()) as Catalog
  expect(updated.providers.find((p) => p.id === 'plein/compatible')!.models[0]!.id).not.toBe(
    initial,
  )
  await settings.screenshot({
    path: test.info().outputPath('compatible-channel-settings.png'),
    animations: 'disabled',
  })
})

test('无凭据的远端 HTTP 配置被拒绝，不把填写地址当作连接成功', async ({ page }) => {
  await newProject(page)
  const settings = await openCanvasSettings(page)
  await settings.getByRole('button', { name: /^模型平台/ }).click()
  const row = settings.locator('[data-provider="plein/compatible"]')
  await row.getByRole('button', { expanded: false }).click()
  await row
    .getByRole('textbox', { name: 'Base URL', exact: true })
    .fill('http://gateway.example.com/v1')
  await row.getByRole('textbox', { name: '模型 ID', exact: true }).fill('example-chat')
  await row.getByRole('button', { name: '保存', exact: true }).click()
  await expect(row.getByRole('alert')).toContainText('远端渠道必须使用 HTTPS')
})
