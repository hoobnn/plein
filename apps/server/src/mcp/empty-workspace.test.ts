import { expect, it } from 'vite-plus/test'
import { bootServer, request } from '../testing'

it('空工作区可以发现能力、传入项目包并预览和导入第一张画布', async () => {
  const source = await bootServer()
  const { id } = (await (
    await request(source.server, '/api/projects', {
      method: 'POST',
      body: JSON.stringify({ title: '首个项目' }),
    })
  ).json()) as { id: string }
  const archive = await request(source.server, `/api/projects/${id}/package`)
  expect(archive.status).toBe(200)
  const base64 = Buffer.from(await archive.arrayBuffer()).toString('base64')

  const { server } = await bootServer()
  const { token } = (await (
    await request(server, '/api/mcp/external', { method: 'POST', body: '{}' })
  ).json()) as { token: string }
  let nextId = 0
  async function call(name: string, args: Record<string, unknown> = {}) {
    const response = await request(server, '/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++nextId,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    })
    const { result } = (await response.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> }
    }
    const text = result.content[0]!.text
    expect(result.isError, text).not.toBe(true)
    return JSON.parse(text)
  }

  for (const name of [
    'list_canvas_capabilities',
    'list_canvas_actions',
    'list_node_types',
    'list_models',
  ])
    expect(await call(name)).toBeTruthy()
  // 复杂 3D 参数可能跨多页；首次连接即可仅凭工具给出的 URI 读取全量契约。
  const node = await call('list_node_types', { type: 'plein/stage' })
  let definitions = node
  if (node.result_omitted) {
    let uri = node.recovery.uri
    let complete = ''
    while (uri) {
      const response = await request(server, '/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++nextId,
          method: 'resources/read',
          params: { uri },
        }),
      })
      const body = (await response.json()) as { result: { contents: [{ text: string }] } }
      const page = JSON.parse(body.result.contents[0].text) as { text: string; next_uri?: string }
      complete += page.text
      uri = page.next_uri
    }
    definitions = JSON.parse(complete)
  }
  expect(definitions[0]).toMatchObject({ type: 'plein/stage', params_schema: { type: 'object' } })
  expect(await call('list_canvases')).toEqual([])
  const { asset_id } = await call('import_asset', {
    source: { name: '首个项目.plein', mime: 'application/zip', base64 },
  })
  expect(asset_id).toBeTruthy()
  const perform = (preview_only: boolean) =>
    call('perform_canvas_action', {
      action: 'import_project_package',
      input: { asset_id, preview_only },
    })
  expect(await perform(true)).toMatchObject({ status: 'preview' })
  expect(await call('list_canvases')).toEqual([])
  expect(server.rooms.loaded()).toEqual([])
  const first = await perform(false)
  expect(first).toMatchObject({ status: 'imported', title: '首个项目' })
  expect(await call('list_canvases')).toMatchObject([{ id: first.canvas_id }])
})
