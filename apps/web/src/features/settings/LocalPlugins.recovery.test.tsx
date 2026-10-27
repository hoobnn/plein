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

const fail = (message: string) => Response.json({ error: 'test_failure', message }, { status: 503 })

/** 会话外的东西都能开关：哪个接口此刻在报错，由 broken 决定 */
interface Fake {
  list: LocalPluginInfo[]
  broken: Set<'list' | 'rescan' | 'enable' | 'reload' | 'catalog'>
  /** 目录读取卡住不返回：用来看看刷新期间界面是不是锁住了 */
  holdCatalog: boolean
  releaseCatalog: () => void
  calls: string[]
}

function fake(over: Partial<Fake> = {}): Fake {
  return {
    list: [echo()],
    broken: new Set(),
    holdCatalog: false,
    releaseCatalog: () => {},
    calls: [],
    ...over,
  }
}

function serve(server: Fake) {
  let held: Promise<Response> | undefined
  return mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    server.calls.push(`${request.method} ${path}`)
    if (path === '/api/plugins/install/status') return Response.json({ available: true })
    if (path === '/api/catalog') {
      if (server.broken.has('catalog')) return fail('节点目录暂不可用')
      if (server.holdCatalog) {
        held ??= new Promise<Response>((resolve) => {
          server.releaseCatalog = () => resolve(Response.json({ nodes: [] }))
        })
        return held
      }
      return Response.json({ nodes: [] })
    }
    if (path === '/api/plugins/local')
      return server.broken.has('list') ? fail('列表暂不可用') : Response.json(server.list)
    if (path === '/api/plugins/local/rescan')
      return server.broken.has('rescan') ? fail('插件操作暂时失败') : Response.json(server.list)
    if (path === '/api/plugins/local/acme/echo/reload')
      return server.broken.has('reload') ? fail('插件操作暂时失败') : Response.json(server.list[0])
    if (path === '/api/plugins/local/acme/echo') {
      if (server.broken.has('enable')) return fail('插件操作暂时失败')
      const body = (await request.json().catch(() => null)) as { enabled?: boolean } | null
      server.list[0] = echo({
        ...server.list[0],
        enabled: body?.enabled === true,
        status: body?.enabled ? 'active' : 'disabled',
      })
      return Response.json(server.list[0])
    }
  })
}

const toggleOf = () => screen.getByRole('switch', { name: '启用 Acme 回声' })
const checked = () => toggleOf().getAttribute('aria-checked')
const disabled = (element: HTMLElement) => (element as HTMLButtonElement).disabled

describe('本机插件读取失败后的重试', () => {
  it('扫描失败给出原因，按钮恢复可用，重试成功后提示清除', async () => {
    const server = fake()
    server.broken.add('rescan')
    serve(server)
    const { user } = renderApp(<LocalPlugins />)
    await screen.findByRole('switch', { name: '启用 Acme 回声' })

    await user.click(screen.getByRole('button', { name: '重新扫描' }))
    await screen.findByText('插件操作失败：插件操作暂时失败')
    expect(disabled(screen.getByRole('button', { name: '重新扫描' }))).toBe(false)
    expect(checked()).toBe('false')

    server.broken.delete('rescan')
    await user.click(screen.getByRole('button', { name: '重新扫描' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('启用失败不把开关改坏，重试成功后状态和列表一致', async () => {
    const server = fake()
    server.broken.add('enable')
    serve(server)
    const { user } = renderApp(<LocalPlugins />)
    await screen.findByRole('switch', { name: '启用 Acme 回声' })

    await user.click(toggleOf())
    await screen.findByText('插件操作失败：插件操作暂时失败')
    expect(checked()).toBe('false')

    server.broken.delete('enable')
    await user.click(toggleOf())
    await waitFor(() => expect(checked()).toBe('true'))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('重新加载失败后仍保持已启用，重试成功才恢复', async () => {
    const server = fake({ list: [echo({ enabled: true, status: 'active' })] })
    server.broken.add('reload')
    serve(server)
    const { user } = renderApp(<LocalPlugins />)
    await screen.findByRole('button', { name: '重新加载' })

    await user.click(screen.getByRole('button', { name: '重新加载' }))
    await screen.findByText('插件操作失败：插件操作暂时失败')
    expect(checked()).toBe('true')

    server.broken.delete('reload')
    await user.click(screen.getByRole('button', { name: '重新加载' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('列表读取失败有反馈和重试入口，重试后拿回真实列表', async () => {
    const server = fake()
    server.broken.add('list')
    serve(server)
    const { user } = renderApp(<LocalPlugins />)
    await screen.findByText('读取插件失败：列表暂不可用')
    expect(screen.queryByRole('switch')).toBeNull()

    server.broken.delete('list')
    await user.click(screen.getByRole('button', { name: '重试读取插件' }))
    await screen.findByRole('switch', { name: '启用 Acme 回声' })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('刷新读取失败保留现有列表，重试后清除过期提示', async () => {
    const server = fake()
    serve(server)
    const { user } = renderApp(<LocalPlugins />)
    await screen.findByRole('switch', { name: '启用 Acme 回声' })

    server.broken.add('list')
    await user.click(screen.getByRole('button', { name: '重新扫描' }))
    await screen.findByText('读取插件失败：列表暂不可用')
    // 旧列表还在：不能因为一次刷新失败就说没有插件
    expect(screen.getByRole('switch', { name: '启用 Acme 回声' })).toBeTruthy()
    expect(screen.queryByText(/还没有本机插件/)).toBeNull()

    server.broken.delete('list')
    await user.click(screen.getByRole('button', { name: '重试读取插件' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByRole('switch', { name: '启用 Acme 回声' })).toBeTruthy()
  })
})

describe('节点目录更新失败后的重试', () => {
  it('目录读取失败只提示目录问题，不牵连插件列表，可单独重试', async () => {
    const server = fake()
    server.broken.add('catalog')
    serve(server)
    const { user } = renderApp(<LocalPlugins />)
    await screen.findByRole('switch', { name: '启用 Acme 回声' })
    await screen.findByText('节点目录更新失败：节点目录暂不可用')
    const retry = screen.getByRole('button', { name: '重试更新节点目录' })
    expect(disabled(retry)).toBe(false)

    // 重试还是失败：提示还在，按钮还能再点
    await user.click(retry)
    await waitFor(() =>
      expect(disabled(screen.getByRole('button', { name: '重试更新节点目录' }))).toBe(false),
    )
    expect(screen.getByText('节点目录更新失败：节点目录暂不可用')).toBeTruthy()

    server.broken.delete('catalog')
    await user.click(screen.getByRole('button', { name: '重试更新节点目录' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('目录刷新期间锁住开关和重新加载，不重复发启停请求', async () => {
    const server = fake()
    serve(server)
    const { user } = renderApp(<LocalPlugins />)
    await screen.findByRole('switch', { name: '启用 Acme 回声' })
    server.broken.add('catalog')
    // 重新扫描会顺带刷新目录：这时目录读不到
    await user.click(screen.getByRole('button', { name: '重新扫描' }))
    await screen.findByText('节点目录更新失败：节点目录暂不可用')

    server.broken.delete('catalog')
    server.holdCatalog = true
    await user.click(screen.getByRole('button', { name: '重试更新节点目录' }))
    const busy = await screen.findByRole('button', { name: '正在更新目录…' })
    expect(disabled(busy)).toBe(true)
    expect(disabled(toggleOf())).toBe(true)
    expect(disabled(screen.getByRole('button', { name: '重新扫描' }))).toBe(true)

    server.releaseCatalog()
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    // 目录刷新不该再发启停请求
    expect(server.calls.filter((c) => c.startsWith('PUT'))).toHaveLength(0)
  })
})
