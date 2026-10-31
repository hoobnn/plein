import { expect, test } from './fixtures'
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

/**
 * 平台配置表单本身已下沉到组件测试；只有「设置弹窗 → 真实接口 → 真实目录 → 回到界面」
 * 这条链路需要真浏览器证明。
 */
test(
  '兼容渠道在设置里配置后，目录与模型身份同步更新',
  { tag: '@core' },
  async ({ page, request }) => {
    await newProject(page)
    const settings = await openCanvasSettings(page)
    await settings.getByRole('button', { name: /^模型平台/ }).click()
    const row = settings.locator('[data-provider="plein/compatible"]')
    // 卡片头部按钮用 aria-controls 定位：页面里还有「更多设置」等其他展开按钮
    await row.locator('button[aria-controls^="provider-"]').click()
    await row.getByLabel('「默认」的API Key', { exact: true }).fill('test-only-not-a-real-key')
    // 未配置时平台设置默认收在「更多设置」里
    await row.getByRole('button', { name: '更多设置', exact: true }).click()
    await row
      .getByRole('textbox', { name: 'Base URL', exact: true })
      .fill('https://gateway.example.com/v1')
    await row.getByRole('textbox', { name: '模型 ID', exact: true }).fill('example-chat')
    await row.getByRole('checkbox', { name: '支持图片输入', exact: true }).check()
    // 未配置时主操作是「保存并校验」，这里只要保存
    await row.getByRole('button', { name: '仅保存', exact: true }).click()
    await expect(row.getByRole('status')).toContainText('已保存')
    await row.getByRole('switch', { name: '启用 兼容对话渠道', exact: true }).click()
    await expect(row.getByRole('switch', { name: '启用 兼容对话渠道', exact: true })).toBeChecked()

    const catalog = (await (await request.get('/api/catalog')).json()) as Catalog
    const provider = catalog.providers.find((p) => p.id === 'plein/compatible')!
    expect(provider.enabled).toBe(true)
    expect(provider.models).toMatchObject([{ title: 'example-chat', features: ['vision'] }])
    const initial = provider.models[0]!.id

    // 没有远端探针的平台只做配置检查，不把填写地址当作连接成功
    await row.getByRole('button', { name: '校验连接', exact: true }).click()
    await expect(row.getByRole('status')).toContainText('尚未验证远端密钥、模型权限或网络')
    await row.getByRole('textbox', { name: '模型 ID', exact: true }).fill('another-chat')
    await expect(row.getByRole('button', { name: '校验连接', exact: true })).toBeDisabled()
    await row.getByRole('button', { name: '保存', exact: true }).click()
    await expect(row.getByRole('status')).toContainText('已保存')

    const updated = (await (await request.get('/api/catalog')).json()) as Catalog
    expect(updated.providers.find((p) => p.id === 'plein/compatible')!.models[0]!.id).not.toBe(
      initial,
    )
  },
)
