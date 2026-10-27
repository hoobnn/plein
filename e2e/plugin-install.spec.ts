import { createRequire } from 'node:module'
import { expect, test } from './fixtures'
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

/**
 * 选 ZIP 文件这一步是浏览器平台行为（真实文件选择、真实 input），组件测试替代不了；
 * 其余预检与安装语义由服务端合同测试和组件测试兜住。
 */
test('选一个插件包：先看清清单权限，确认后装上且默认禁用', { tag: '@core' }, async ({ page }) => {
  await newProject(page)
  await openCanvasSettings(page)
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: /^插件/ }).click()
  await expect(settings.getByRole('button', { name: '安装插件包', exact: true })).toBeEnabled()
  await settings.getByTestId('plugin-install-file').setInputFiles({
    name: 'example.zip',
    mimeType: 'application/zip',
    buffer: pack('acme/install-ui'),
  })
  const preview = page.getByRole('dialog', { name: '安装本机插件', exact: true })
  await expect(preview).toContainText('安装示例 acme/install-ui')
  await expect(preview).toContainText('联网 example.com')
  await expect(preview).toContainText('密钥 INSTALL_EXAMPLE_KEY')
  await expect(preview).toContainText('未执行插件代码')
  await preview.getByRole('button', { name: '确认安装（暂不启用）', exact: true }).click()
  await expect(preview).toHaveCount(0)
  const row = settings.locator('[data-plugin="acme/install-ui"]')
  await expect(row).toContainText('未启用')
  await expect(row.getByRole('switch')).not.toBeChecked()
})
