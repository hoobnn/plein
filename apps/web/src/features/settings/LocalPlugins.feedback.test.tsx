// @vitest-environment happy-dom
import type { LocalPluginInfo } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { useCatalog } from '../../stores/catalog'
import { mockFetch } from '../../testing/fetch'
import { renderApp, resetStoreAfterEach, screen, waitFor } from '../../testing/render'
import { LocalPlugins } from './LocalPlugins'

resetStoreAfterEach(useCatalog)

const echo = (over: Partial<LocalPluginInfo> = {}): LocalPluginInfo => ({
  id: 'acme/echo',
  name: 'Acme 回声',
  version: '1.0.0',
  dir: '/tmp/plugins/acme-echo',
  enabled: false,
  status: 'disabled',
  permissions: { network: ['localhost'], secrets: ['ACME_ECHO_KEY'], assets: 'none', media: false },
  contributes: {
    nodes: ['acme/shout@1'],
    providers: [],
    prompts: [],
    templates: [],
    elements: [],
    capabilities: [],
  },
  ...over,
})

interface Handlers {
  list?: LocalPluginInfo[]
  enable?(request: Request): Response
  rescan?(request: Request): Response
}

function serve({ list = [echo()], enable, rescan }: Handlers = {}) {
  return mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path === '/api/plugins/install/status') return Response.json({ available: true })
    if (path === '/api/catalog') return Response.json({ nodes: [] })
    if (path === '/api/plugins/local/acme%2Fecho' || path === '/api/plugins/local/acme/echo')
      return enable?.(request) ?? Response.json(echo({ enabled: true, status: 'active' }))
    if (path === '/api/plugins/local/rescan') return rescan?.(request) ?? Response.json([])
    return Response.json(list)
  })
}

describe('本机插件操作后的反馈', () => {
  it('启用成功说明启用了哪个插件', async () => {
    serve()
    renderApp(<LocalPlugins />)
    const toggle = await screen.findByRole('switch', { name: '启用 Acme 回声' })
    toggle.click()
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('已启用「Acme 回声」'))
  })

  it('重新扫描完成说明扫过了', async () => {
    serve()
    renderApp(<LocalPlugins />)
    await screen.findByRole('switch', { name: '启用 Acme 回声' })
    screen.getByRole('button', { name: '重新扫描' }).click()
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('已重新扫描本机插件'))
  })

  it('操作失败说明失败原因，不写成功的话', async () => {
    serve({
      enable: () => Response.json({ error: 'invalid', message: '插件清单损坏' }, { status: 400 }),
    })
    renderApp(<LocalPlugins />)
    const toggle = await screen.findByRole('switch', { name: '启用 Acme 回声' })
    toggle.click()
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('插件操作失败：插件清单损坏'),
    )
    expect(screen.queryByRole('status')).toBeNull()
  })
})
