import { createRequire } from 'node:module'
import { expect, test } from '@playwright/test'
import { newProject } from './canvas'
import { openCanvasSettings } from './settings-ui'

const { zipSync } = createRequire(new URL('../apps/server/package.json', import.meta.url))(
  'fflate',
) as {
  zipSync(files: Record<string, Uint8Array>, options: { level: number }): Uint8Array
}

const pack = (id: string, extra: Record<string, Uint8Array> = {}) =>
  Buffer.from(
    zipSync(
      {
        'plein-plugin.json': new TextEncoder().encode(
          JSON.stringify({
            id,
            version: '1.0.0',
            name: `安装示例 ${id}`,
            engines: { plein: '^0.1.0' },
            main: { server: 'dist/server.mjs' },
            contributes: { templates: [`${id}-template`] },
            permissions: {
              network: ['example.com'],
              secrets: ['INSTALL_EXAMPLE_KEY'],
              assets: 'read',
            },
          }),
        ),
        // 此受控测试入口若在预检/安装时执行就会失败；用例不启用插件。
        'dist/server.mjs': new TextEncoder().encode('throw new Error("安装不应执行插件")'),
        ...extra,
      },
      { level: 0 },
    ),
  )

test('插件包先展示清单权限，确认后默认禁用，重复 ID 不覆盖', async ({ page }) => {
  await newProject(page)
  await openCanvasSettings(page)
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: /^插件/ }).click()
  await expect(settings.getByRole('button', { name: '安装插件包', exact: true })).toBeEnabled()
  const buffer = pack('acme/install-ui')
  await settings
    .getByTestId('plugin-install-file')
    .setInputFiles({ name: 'example.zip', mimeType: 'application/zip', buffer })
  const preview = page.getByRole('dialog', { name: '安装本机插件', exact: true })
  await expect(preview).toContainText('安装示例 acme/install-ui')
  await expect(preview).toContainText('联网 example.com')
  await expect(preview).toContainText('密钥 INSTALL_EXAMPLE_KEY')
  await expect(preview).toContainText('未执行插件代码')
  const before = (await (await page.request.get('/api/plugins/local')).json()) as Array<{
    id: string
  }>
  expect(before.some((p) => p.id === 'acme/install-ui')).toBe(false)
  await preview.screenshot({ path: test.info().outputPath('plugin-install-preview.png') })
  await preview.getByRole('button', { name: '确认安装（暂不启用）', exact: true }).click()
  await expect(preview).toHaveCount(0)
  const row = settings.locator('[data-plugin="acme/install-ui"]')
  await expect(row).toContainText('未启用')
  await expect(row.getByRole('switch')).not.toBeChecked()
  await row.screenshot({ path: test.info().outputPath('plugin-installed-disabled.png') })
  await settings
    .getByTestId('plugin-install-file')
    .setInputFiles({ name: 'example.zip', mimeType: 'application/zip', buffer })
  await expect(settings.getByRole('alert')).toContainText('插件 ID 已存在')
  await expect(row).toContainText('未启用')
})

test('取消插件预检不安装，路径穿越包显示失败且无可启用插件', async ({ page }) => {
  await newProject(page)
  await openCanvasSettings(page)
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: /^插件/ }).click()
  const file = settings.getByTestId('plugin-install-file')
  await file.setInputFiles({
    name: 'cancel.zip',
    mimeType: 'application/zip',
    buffer: pack('acme/install-cancel'),
  })
  const preview = page.getByRole('dialog', { name: '安装本机插件', exact: true })
  await expect(preview).toBeVisible()
  await preview.getByRole('button', { name: '取消', exact: true }).click()
  await expect(preview).toHaveCount(0)
  expect(
    ((await (await page.request.get('/api/plugins/local')).json()) as Array<{ id: string }>).some(
      (p) => p.id === 'acme/install-cancel',
    ),
  ).toBe(false)
  await file.setInputFiles({
    name: 'invalid.zip',
    mimeType: 'application/zip',
    buffer: pack('acme/install-invalid', { '../outside.mjs': new TextEncoder().encode('invalid') }),
  })
  await expect(settings.getByRole('alert')).toContainText('不安全路径')
  await expect(settings.locator('[data-plugin="acme/install-invalid"]')).toHaveCount(0)
})
