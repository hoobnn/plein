import { openCanvasSettings } from './settings-ui'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { addNode, elements, newProject, waitNode } from './canvas'

const endpoint = '/api/plugins/local/acme/echo'
const directory = () => join(process.env.PLEIN_E2E_DATA!, 'plugins/acme-echo')
test.beforeAll(() => {
  execFileSync(process.execPath, [
    join(import.meta.dirname, '../examples/plugins/acme-echo/build.mjs'),
    directory(),
  ])
})

for (const recovery of ['reload', 'disable'] as const) {
  test(`清单损坏后身份保留，可通过 ${recovery} 修复并真实执行`, async ({ page, request }) => {
    const file = join(directory(), 'plein-plugin.json')
    const original = readFileSync(file, 'utf8')
    await request.post('/api/plugins/local/rescan')
    expect((await request.put(endpoint, { data: { enabled: true } })).ok()).toBe(true)
    try {
      await page.setViewportSize({ width: 800, height: 560 })
      await newProject(page)
      await openCanvasSettings(page)
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.getByRole('button', { name: /^插件/ }).click()
      const row = settings.locator('[data-plugin="acme/echo"]')
      await expect(row).toContainText('已加载')
      writeFileSync(file, '{ invalid json')
      await row.getByRole('button', { name: '重新加载', exact: true }).click()
      await expect(row).toContainText('出错')
      await expect(row.getByRole('alert')).toContainText('清单读不出来')
      await expect(row.getByRole('switch')).toBeChecked()
      expect(
        (await (await request.get('/api/plugins/local')).json()).some(
          (plugin: { id: string }) => plugin.id === 'acme-echo',
        ),
      ).toBe(false)
      await settings.screenshot({
        path: test.info().outputPath('broken-manifest.png'),
        animations: 'disabled',
      })
      if (recovery === 'disable') {
        await row.getByRole('switch').click()
        await expect(row.getByRole('switch')).toHaveCount(0)
        expect(
          (await (await request.get('/api/plugins/local')).json()).find(
            (plugin: { id: string }) => plugin.id === 'acme/echo',
          ).enabled,
        ).toBe(false)
        writeFileSync(file, original)
        await settings.getByRole('button', { name: '重新扫描', exact: true }).click()
        await expect(row.getByRole('switch')).not.toBeChecked()
        await row.getByRole('switch').click()
      } else {
        writeFileSync(file, original)
        await row.getByRole('button', { name: '重新加载', exact: true }).click()
      }
      await expect(row).toContainText('已加载')
      await expect(row.getByRole('alert')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await page.setViewportSize({ width: 1440, height: 900 })
      await addNode(page, '大声说')
      const node = (await elements(page)).find((element) => element.nodeType === 'acme/shout')!
      const generator = page.getByTestId('generator')
      await generator.getByRole('textbox', { name: '提示词', exact: true }).fill('recovered')
      await generator.getByRole('button', { name: '生成', exact: true }).click()
      await waitNode(page, node.id)
      await expect(page.getByText('RECOVERED!', { exact: true })).toBeVisible()
    } finally {
      writeFileSync(file, original)
      await request.post('/api/plugins/local/rescan')
      await request.put(endpoint, { data: { enabled: false } })
    }
  })
}
