// @vitest-environment happy-dom
import type { LocalPluginInfo } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { useCatalog } from '../../stores/catalog'
import { mockFetch } from '../../testing/fetch'
import { renderApp, resetStoreAfterEach, screen } from '../../testing/render'
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

function serve(list: LocalPluginInfo[]) {
  return mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path === '/api/plugins/install/status') return Response.json({ available: true })
    if (path === '/api/catalog') return Response.json({ nodes: [] })
    return Response.json(list)
  })
}

const row = () => document.querySelector('[data-plugin="acme/echo"]')!

describe('本机插件行的展示', () => {
  it('按状态显示未启用、已加载和出错', async () => {
    serve([echo()])
    renderApp(<LocalPlugins />)
    await screen.findByRole('switch', { name: '启用 Acme 回声' })
    expect(row().textContent).toContain('未启用')
  })

  it('已加载时如实显示权限和隔离程度', async () => {
    serve([
      echo({
        enabled: true,
        status: 'active',
        sandbox: { permission: true, fsWrite: false, net: true },
      }),
    ])
    renderApp(<LocalPlugins />)
    await screen.findByRole('button', { name: '重新加载' })
    expect(row().textContent).toContain('已加载')
    expect(row().textContent).toContain('联网 localhost')
    expect(row().textContent).toContain('密钥 ACME_ECHO_KEY')
    // 子进程实测的网络隔离情况如实显示
    expect(row().textContent).toContain('文件已隔离 · 网络未隔离')
  })

  it('清单坏了标成出错，写明原因，但仍然能停用', async () => {
    serve([echo({ enabled: true, status: 'error', error: '清单读不出来' })])
    renderApp(<LocalPlugins />)
    const toggle = await screen.findByRole('switch', { name: '启用 Acme 回声' })
    expect(row().textContent).toContain('出错')
    expect(row().textContent).toContain('清单读不出来')
    // 出错时开关仍停在启用位置，用户还能把它关掉
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })
})
