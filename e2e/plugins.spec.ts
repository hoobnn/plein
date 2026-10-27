import { openCanvasSettings } from './settings-ui'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { addNode, elements, newProject, revealGenerator, waitNode } from './canvas'

/** 设了就把界面截图存到这个目录（亮色、暗色各一张） */
const shotDir = process.env.PLEIN_E2E_SHOTS

async function shoot(page: Page, name: string) {
  if (!shotDir) return
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(shotDir, `${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: null })
}

test(
  '本机第三方插件：放进数据目录、看权限、启用后节点可用，停用后撤下',
  { tag: '@core' },
  async ({ page }) => {
    // 示例插件打包进服务端的数据目录 plugins/
    const root = join(import.meta.dirname, '..')
    execFileSync(process.execPath, [
      join(root, 'examples/plugins/acme-echo/build.mjs'),
      join(process.env.PLEIN_E2E_DATA!, 'plugins', 'acme-echo'),
    ])

    await newProject(page)
    await openCanvasSettings(page)
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.getByRole('button', { name: /^插件/ }).click()
    await settings.getByRole('button', { name: '重新扫描' }).click()
    const row = settings.locator('[data-plugin="acme/echo"]')
    await expect(row).toContainText('未启用')
    await expect(row).toContainText('联网 localhost')
    await expect(row).toContainText('密钥 ACME_ECHO_KEY')

    await row.getByRole('switch', { name: '启用 Acme 回声' }).click()
    await expect(row).toContainText('已加载', { timeout: 20_000 })
    await expect(row).toContainText(/已隔离|未隔离/)
    await shoot(page, 'settings')

    await page.keyboard.press('Escape')
    await addNode(page, '大声说')
    await expect
      .poll(async () => (await elements(page)).some((e) => e.nodeType === 'acme/shout'))
      .toBe(true)
    const node = (await elements(page)).find((e) => e.nodeType === 'acme/shout')!
    // 执行器在插件子进程里跑
    const generator = page.getByTestId('generator')
    await generator.getByRole('textbox', { name: '提示词' }).fill('hello')
    // 编辑器固定在卡片下方，控件可能在窗口外：先把它移进窗口
    const generate = generator.getByRole('button', { name: '生成', exact: true })
    await revealGenerator(page, generate)
    await generate.click()
    await waitNode(page, node.id)
    await expect(page.getByText('HELLO!')).toBeVisible()
    await shoot(page, 'node')

    // 停用：节点从目录里撤下，画布上已有的保留
    await openCanvasSettings(page)
    await settings.getByRole('button', { name: /^插件/ }).click()
    await row.getByRole('switch', { name: '启用 Acme 回声' }).click()
    await expect(row).toContainText('未启用')
  },
)
