import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { addNode, elements, newProject, waitNode } from './canvas'

const FIXTURE = fileURLToPath(
  new URL('../apps/server/test-fixtures/mcp-server.mjs', import.meta.url),
)

/** 外部 MCP 服务：设置里添加，画布上的「MCP 工具」节点选工具、填参数、运行 */
test('添加 MCP 服务，用 MCP 工具节点调用它', async ({ page }) => {
  await newProject(page)
  // 还没接 MCP 服务时，添加菜单里没有这个节点
  await page.mouse.dblclick(720, 450)
  await page.getByPlaceholder('添加节点').fill('MCP 工具')
  await expect(page.getByRole('option', { name: /MCP 工具/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
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

/** 对外开放 MCP：生成令牌，拿到能直接贴的配置，外部应用用它连进来 */
test('生成对外令牌，外部应用能连进来', async ({ page, request }) => {
  await newProject(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置' })
  await settings.getByRole('button', { name: /^MCP 服务/ }).click()
  await settings.getByRole('button', { name: '生成连接令牌' }).click()
  const config = settings.getByTestId('external-mcp-config')
  await expect(config).toContainText('claude mcp add --transport http plein')
  const token = /Bearer (plein_[\w-]+)/.exec((await config.textContent()) ?? '')![1]!
  await settings.getByRole('button', { name: 'Cursor 等' }).click()
  await expect(config).toContainText('"mcpServers"')

  const res = await request.post('/mcp', {
    headers: { authorization: `Bearer ${token}` },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_canvases', arguments: {} },
    },
  })
  const body = (await res.json()) as { result: { content: Array<{ text: string }> } }
  expect(JSON.parse(body.result.content[0]!.text)[0]).toHaveProperty('viewing', true)
})
