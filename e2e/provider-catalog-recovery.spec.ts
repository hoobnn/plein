import { openCanvasSettings } from './settings-ui'
import { expect, type Page, test } from './fixtures'
import { addNode, elements, newProject } from './canvas'

const configUrl = '/api/providers/plein/mock/config'
const modelUrl = '/api/model-defaults'
const defaults = { enabled: true, settings: { latencyMs: 0, queueMs: 0, failWith: 'none' } }
test.beforeEach(async ({ request }) => {
  expect((await request.put(configUrl, { data: defaults })).ok()).toBe(true)
  expect(
    (
      await request.put(modelUrl, { data: { capability: 'text.chat', model: 'plein/mock:agent' } })
    ).ok(),
  ).toBe(true)
})
test.afterEach(async ({ request }) => {
  await request.put(configUrl, { data: defaults })
  await request.put(modelUrl, { data: { capability: 'text.chat', model: 'plein/mock:agent' } })
})
async function openProviders(page: Page) {
  await page.setViewportSize({ width: 800, height: 560 })
  await newProject(page)
  await openCanvasSettings(page)
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: /^模型平台/ }).click()
  await expect(settings.getByRole('combobox', { name: '默认文本模型', exact: true })).toBeVisible()
  return settings
}

for (const kind of ['default', 'enabled', 'config'] as const) {
  test(`平台 ${kind} 已保存但目录读取失败时保留界面，独立重试不重复写入`, async ({
    page,
    request,
  }) => {
    const settings = await openProviders(page)
    const row = settings.locator('[data-provider="plein/mock"]')
    const textModel = settings.getByRole('combobox', { name: '默认文本模型', exact: true })
    if (kind === 'config') {
      await row.getByRole('button', { expanded: false }).click()
      await row.getByRole('spinbutton', { name: '模拟耗时（毫秒）', exact: true }).fill('321')
    }
    let writes = 0
    page.on('request', (req) => {
      if (req.method() === 'PUT' && (req.url().endsWith(configUrl) || req.url().endsWith(modelUrl)))
        writes++
    })
    let failing = true
    let hold = false
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/api/catalog', async (route) => {
      if (failing)
        await route.fulfill({
          status: 503,
          json: { error: 'test_failure', message: '平台目录暂不可用' },
        })
      else {
        if (hold) await gate
        await route.continue()
      }
    })
    if (kind === 'default') {
      await textModel.click()
      await page
        .getByRole('option', { name: 'Mock（开发测试用） · Mock 对话', exact: true })
        .click()
    } else if (kind === 'enabled') await row.getByRole('switch').click()
    else await row.getByRole('button', { name: '保存', exact: true }).click()
    await expect(settings.getByRole('alert')).toContainText('平台目录暂不可用')
    await expect(settings.getByRole('alert')).toBeInViewport()
    await expect(
      settings.getByText('当前显示上次读取的目录；已完成的保存无需重复。', { exact: true }),
    ).toBeVisible()
    const persisted = await (await request.get(configUrl)).json()
    const catalog = await (await request.get('/api/catalog')).json()
    if (kind === 'default') {
      expect(catalog.defaultModels['text.chat']).toBe('plein/mock:chat')
      await expect(textModel).toContainText('Mock 智能体')
    } else if (kind === 'enabled') {
      expect(persisted.enabled).toBe(false)
      await expect(row.getByRole('switch')).toBeChecked()
    } else {
      expect(persisted.settings.latencyMs).toBe(321)
      await expect(
        row.getByRole('spinbutton', { name: '模拟耗时（毫秒）', exact: true }),
      ).toHaveValue('321')
      await expect(row.getByRole('status')).toContainText('已保存')
    }
    await expect(textModel).toBeDisabled()
    await expect(row.getByRole('switch')).toBeDisabled()
    if (kind === 'config')
      await expect(row.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
    const retry = settings.getByRole('button', { name: '重试更新平台目录', exact: true })
    const failedRetry = page.waitForResponse(
      (response) => response.url().endsWith('/api/catalog') && response.status() === 503,
    )
    await retry.click()
    await failedRetry
    await expect(retry).toBeEnabled()
    expect(writes).toBe(1)
    if (kind === 'default')
      await settings.screenshot({
        path: test.info().outputPath('platform-catalog-error.png'),
        animations: 'disabled',
      })
    failing = false
    hold = true
    try {
      await retry.click()
      await expect(
        settings.getByRole('button', { name: '正在更新平台目录…', exact: true }),
      ).toBeDisabled()
      await expect(row.getByRole('switch')).toBeDisabled()
      release()
      await expect(settings.getByRole('alert')).toHaveCount(0)
      await expect(row.getByRole('switch')).toBeEnabled()
      expect(writes).toBe(1)
      if (kind === 'enabled') {
        await expect(row.getByRole('switch')).not.toBeChecked()
        await expect(textModel).toHaveCount(0)
      } else {
        await expect(textModel).toBeEnabled()
        if (kind === 'default') {
          await expect(textModel).toContainText('Mock 对话')
          await settings.getByRole('button', { name: '关闭', exact: true }).click()
          await page.setViewportSize({ width: 1440, height: 900 })
          await addNode(page, 'LLM')
          const created = (await elements(page)).find(
            (element) => element.nodeType === 'plein/llm',
          )!
          expect(
            await page.evaluate(
              (id) => window.__plein.engine.doc.get(id)?.params?.model,
              created.id,
            ),
          ).toBe('plein/mock:chat')
        } else await expect(row.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
      }
    } finally {
      release()
    }
  })
}
