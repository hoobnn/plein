import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { addNode, elements, newProject, waitNode } from './canvas'

const FIXTURE = fileURLToPath(
  new URL('../apps/server/test-fixtures/mcp-server.mjs', import.meta.url),
)

/** 外部 MCP 服务：设置里添加，画布上的「MCP 工具」节点选工具、填参数、运行 */
test('添加 MCP 服务，用 MCP 工具节点调用它', async ({ page }) => {
  await newProject(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置' })
  await settings.getByRole('button', { name: /^MCP 服务/ }).click()
  await settings.getByRole('button', { name: '添加 MCP 服务' }).click()
  await settings.getByLabel('名称').fill('测试服务')
  await settings
    .getByLabel('命令', { exact: true })
    .fill(`${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)}`)
  await settings.getByLabel('环境变量（可选）').fill('GREETING=你好，')
  await settings.getByRole('button', { name: '添加', exact: true }).click()
  const row = settings.locator('[data-mcp="测试服务"]')
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: '测试连接' }).click()
  await expect(row.getByRole('status')).toContainText('3 个工具：echo、swatch、fail')
  await page.keyboard.press('Escape')

  await addNode(page, 'MCP 工具')
  const generator = page.getByTestId('generator')
  await generator.getByRole('combobox', { name: 'MCP 服务' }).click()
  await page.getByRole('option', { name: '测试服务' }).click()
  await generator.getByRole('combobox', { name: '工具' }).click()
  await page.getByRole('option', { name: 'echo' }).click()
  // 换工具时按参数说明填好模板：必填的文字参数是 {{input}}
  const args = generator.getByRole('textbox', { name: '参数（JSON）' })
  await expect(args).toHaveValue(/"text": "\{\{input\}\}"/)
  await args.fill('{"text": "雨夜天台"}')
  await generator.getByRole('button', { name: /^生成/ }).click()

  const node = (await elements(page)).find((e) => e.nodeType === 'plein/mcp-tool')!
  await waitNode(page, node.id)
  await expect(page.getByText('你好，雨夜天台').first()).toBeVisible()
})
