import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

/** 对外开放 MCP：生成令牌，拿到能直接贴的配置，外部应用用它连进来 */
test('生成对外令牌，外部应用能连进来', { tag: '@core' }, async ({ page, request }) => {
  await newProject(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置' })
  await settings.getByRole('button', { name: 'MCP', exact: true }).click()
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
