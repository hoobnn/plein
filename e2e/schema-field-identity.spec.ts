import { expect, test } from '@playwright/test'
import type { Catalog } from '../packages/protocol/src/plugins'
import { clickElement, newProject } from './canvas'

test('模型与通用同名字段各自关联标签、说明和保存位置', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 560 })
  await page.route('**/api/catalog', async (route) => {
    const response = await route.fetch()
    const catalog = (await response.json()) as Catalog
    const model = catalog.providers
      .find((p) => p.id === 'plein/mock')!
      .models.find((m) => m.id === 'audio')!
    model.optionsSchema = {
      type: 'object',
      properties: {
        speed: {
          type: 'number',
          title: '模型专用语速',
          description: '模型专用倍率',
          minimum: 0,
          maximum: 3,
        },
        flag: { type: 'boolean', title: '模型开关' },
      },
    }
    await route.fulfill({ response, json: catalog })
  })
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/speech',
      name: '字段身份',
      x: 400,
      y: 200,
      params: {
        model: 'plein/mock:audio',
        text: '字段身份',
        speed: 1,
        options: { 'plein/mock:audio': { speed: 0.5 } },
      },
    }),
  )
  await clickElement(page, id)
  await page.getByRole('button', { name: '参数', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '参数', exact: true })
  await panel.getByRole('button', { name: '更多参数', exact: true }).click()
  const commonLabel = panel.locator('label').filter({ hasText: /^语速$/ })
  const modelLabel = panel.locator('label').filter({ hasText: /^模型专用语速$/ })
  const common = commonLabel.locator('..').getByRole('spinbutton')
  const specific = modelLabel.locator('..').getByRole('spinbutton')
  await commonLabel.click()
  await expect(common).toBeFocused()
  await expect(common).toHaveAccessibleName('语速')
  await expect(specific).toHaveAccessibleName('模型专用语速')
  await expect(specific).toHaveAccessibleDescription('模型专用倍率')
  await expect(common).not.toHaveAccessibleDescription('模型专用倍率')
  await common.fill('1.2')
  await common.press('Enter')
  await modelLabel.click()
  await expect(specific).toBeFocused()
  await specific.fill('0.8')
  await specific.press('Enter')
  const params = await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!, id)
  expect(params.speed).toBe(1.2)
  expect(params.options).toEqual({ 'plein/mock:audio': { speed: 0.8 } })
  await panel.getByRole('combobox', { name: '模型开关', exact: true }).click()
  await expect(page.getByRole('listbox')).toHaveAccessibleName('模型开关')
  await page.getByRole('option', { name: '开', exact: true }).click()
  await expect(common).toHaveValue('1.2')
  await expect(specific).toHaveValue('0.8')
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.options, id),
  ).toEqual({ 'plein/mock:audio': { speed: 0.8, flag: true } })
  await panel.screenshot({
    path: test.info().outputPath('independent-schema-fields.png'),
    animations: 'disabled',
  })
})
