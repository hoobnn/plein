import { afterAll, beforeAll, expect, it } from 'vite-plus/test'
import { type Client, snippet } from '../../../web/src/features/settings/externalMcpConfig'
import { request, startTestServer } from '../testing'

let running: Awaited<ReturnType<typeof startTestServer>>
beforeAll(async () => {
  running = await startTestServer()
})
afterAll(() => running.close())

/** 按客户端配置消费认证信息，向真实 MCP 路由请求工具列表。 */
function headers(client: Client, config: string) {
  if (client === 'claude-code')
    return {
      authorization: /--header "(Authorization: [^"]+)"/
        .exec(config)![1]!
        .slice('Authorization: '.length),
    }
  const server = JSON.parse(config).mcpServers.plein
  if (client === 'json') return { authorization: server.headers.Authorization }
  expect(server.command).toBe('npx')
  expect(server.args.slice(0, 2)).toEqual(['-y', 'mcp-remote'])
  const header = server.args[server.args.indexOf('--header') + 1] as string
  return {
    authorization: header
      .replace(/\$\{([^}]+)\}/g, (_, key: string) => server.env[key])
      .slice('Authorization:'.length),
  }
}

it.each(['claude-code', 'json', 'claude-desktop'] as const)(
  '%s 生成配置可实际接入，轮换与关闭使旧配置失效',
  async (client) => {
    const { server } = running
    const issue = async () =>
      (
        (await (await request(server, '/api/mcp/external', { method: 'POST' })).json()) as {
          token: string
        }
      ).token
    const url = 'http://127.0.0.1:8787/mcp'
    const rpc = (config: string) =>
      server.app.request('/mcp', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:8787',
          'content-type': 'application/json',
          ...headers(client, config),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
    const config = snippet(client, url, await issue())
    expect(config).toContain(url)
    const first = await rpc(config)
    expect(first.status).toBe(200)
    expect(
      ((await first.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map(
        (tool) => tool.name,
      ),
    ).toContain('list_canvases')
    const next = snippet(client, url, await issue())
    expect((await rpc(config)).status).toBe(401)
    expect((await rpc(next)).status).toBe(200)
    await request(server, '/api/mcp/external', { method: 'DELETE' })
    expect((await rpc(next)).status).toBe(401)
  },
)
