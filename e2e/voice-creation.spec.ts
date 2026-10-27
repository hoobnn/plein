import { expect, test } from './fixtures'
import { newProject } from './canvas'
import { openLibraryPanel } from './library-ui'

test('音色设计与复刻分开；设计不上传音频，保存试听并在重新打开后保留', async ({ page }) => {
  await newProject(page)
  const panel = await openLibraryPanel(page)
  await panel.getByRole('button', { name: '音色', exact: true }).click()
  await panel.getByRole('button', { name: '音色设计', exact: true }).click()
  await expect(panel.getByRole('heading', { name: '音色设计', exact: true })).toBeVisible()
  await expect(panel.getByLabel('选择样本音频', { exact: true })).toHaveCount(0)
  await panel.getByRole('textbox', { name: '名称', exact: true }).fill('测试设计音色')
  await panel.getByRole('textbox', { name: '音色描述', exact: true }).fill('温柔、沉稳的女声')
  const create = panel.getByRole('button', { name: '设计音色', exact: true })
  await expect(create).toBeDisabled()
  await panel.getByRole('textbox', { name: '试听文本', exact: true }).fill('这是一段试听文本。')
  await expect(create).toBeEnabled()
  await panel.screenshot({ path: test.info().outputPath('voice-design-form.png') })
  await create.click()
  const row = panel.getByRole('listitem').filter({ hasText: '测试设计音色' })
  await expect(row).toContainText('设计音色')
  const audio = row.locator('audio')
  await expect(audio).toHaveAttribute('aria-label', '测试设计音色的试听音频')
  await expect(audio).toHaveAttribute('preload', 'none')
  expect(await audio.evaluate((el) => (el as HTMLAudioElement).paused)).toBe(true)
  const response = await page.request.get('/api/voices')
  const voice = (await response.json()).find((v: { name: string }) => v.name === '测试设计音色')
  expect(voice).toMatchObject({
    source: 'design',
    sampleAssetId: null,
    status: 'ready',
    previewAssetId: expect.any(String),
  })
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  await openLibraryPanel(page)
  await panel.getByRole('button', { name: '音色', exact: true }).click()
  await expect(row).toBeVisible()
  await panel.screenshot({ path: test.info().outputPath('voice-design-result.png') })
  await panel.getByRole('button', { name: '上传声音复刻', exact: true }).first().click()
  await expect(panel.getByLabel('选择样本音频', { exact: true })).toHaveCount(1)
  await expect(panel.getByRole('textbox', { name: '音色描述', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('checkbox', { name: /降噪/ })).not.toBeChecked()
  await expect(panel.getByRole('checkbox', { name: '音量归一化', exact: true })).not.toBeChecked()
  await page.setViewportSize({ width: 800, height: 700 })
  await panel.screenshot({ path: test.info().outputPath('voice-clone-form-narrow.png') })
})

test('豆包与 MiniMax 各自展示设计和复刻参数，平台切换清除不兼容输入', async ({ page }) => {
  await page.route('**/api/catalog', async (route) => {
    const response = await route.fetch()
    const catalog = await response.json()
    for (const provider of catalog.providers) {
      if (['doubao/speech', 'minimax/api'].includes(provider.id)) provider.enabled = true
    }
    await route.fulfill({ response, json: catalog })
  })
  await newProject(page)
  const panel = await openLibraryPanel(page)
  await panel.getByRole('button', { name: '音色', exact: true }).click()
  await panel.getByRole('button', { name: '音色设计', exact: true }).click()
  const select = async (label: string, option: string) => {
    await panel.getByRole('combobox', { name: label, exact: true }).click()
    await page.getByRole('option', { name: option, exact: true }).click()
    await expect(page.locator(`[role="listbox"][aria-label="${label}"]`)).toBeHidden()
  }
  await select('平台', '豆包语音')
  await expect(panel.getByRole('textbox', { name: '音色 ID', exact: true })).toBeVisible()
  await expect(panel.getByLabel('选择角色图片（可选）', { exact: true })).toHaveCount(1)
  await expect(panel.getByRole('textbox', { name: '音色描述', exact: true })).toHaveAttribute(
    'maxlength',
    '200',
  )
  await expect(panel.getByRole('textbox', { name: '试听文本', exact: true })).toHaveAttribute(
    'maxlength',
    '300',
  )
  await panel.screenshot({ path: test.info().outputPath('doubao-voice-design.png') })
  await select('平台', 'MiniMax')
  await expect(panel.getByLabel('选择角色图片（可选）', { exact: true })).toHaveCount(0)
  await expect(panel.getByRole('textbox', { name: '音色 ID', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('textbox', { name: '试听文本', exact: true })).toHaveAttribute(
    'maxlength',
    '500',
  )
  await panel.getByRole('button', { name: '取消', exact: true }).click()
  await panel.getByRole('button', { name: '上传声音复刻', exact: true }).first().click()
  await select('平台', '豆包语音')
  await expect(panel).toContainText('短音频可提交')
  await select('音色类型', '后付费自定义音色')
  await expect(panel.getByRole('textbox', { name: '音色 ID（可选）', exact: true })).toBeVisible()
  await panel.screenshot({ path: test.info().outputPath('doubao-voice-custom-clone.png') })
  await select('平台', 'MiniMax')
  await expect(panel.getByRole('textbox', { name: '音色 ID（可选）', exact: true })).toHaveCount(0)
  await panel.getByText('增强参考（可选）', { exact: true }).click()
  await expect(panel.getByLabel('选择增强参考音频', { exact: true })).toHaveCount(1)
  await expect(panel).toContainText('小于 8 秒')
  await panel.screenshot({ path: test.info().outputPath('minimax-voice-clone.png') })
})
