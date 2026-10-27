// @vitest-environment happy-dom
import type { LocalPluginInfo, PluginInstallPreview } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { mockFetch } from '../../testing/fetch'
import {
  fireEvent,
  renderApp,
  resetStoreAfterEach,
  screen,
  waitFor,
  within,
} from '../../testing/render'
import { LocalPlugins } from './LocalPlugins'

resetStoreAfterEach(useCatalog)

const manifest = {
  id: 'acme/install-ui',
  version: '1.0.0',
  name: '安装示例 acme/install-ui',
  engines: { plein: '^0.1.0' },
  main: { server: 'dist/server.mjs' },
  contributes: {
    nodes: [],
    providers: [],
    prompts: [],
    templates: ['acme/install-ui-template'],
    elements: [],
    capabilities: [],
  },
  permissions: {
    network: ['example.com'],
    secrets: ['INSTALL_EXAMPLE_KEY'],
    assets: 'read' as const,
    media: false,
  },
}

const preview = (over: Partial<PluginInstallPreview> = {}): PluginInstallPreview => ({
  token: '11111111-1111-4111-8111-111111111111',
  expiresAt: Date.now() + 600_000,
  sha256: 'a'.repeat(64),
  files: 2,
  bytes: 2048,
  manifest: manifest as PluginInstallPreview['manifest'],
  ...over,
})

const installed = (over: Partial<LocalPluginInfo> = {}): LocalPluginInfo => ({
  id: 'acme/install-ui',
  name: '安装示例 acme/install-ui',
  version: '1.0.0',
  dir: '/tmp/plugins/acme-install-ui',
  enabled: false,
  status: 'disabled',
  permissions: manifest.permissions,
  contributes: {
    nodes: [],
    providers: [],
    prompts: [],
    templates: [],
    elements: [],
    capabilities: [],
  },
  ...over,
})

interface Fake {
  /** 预检返回什么；返回 undefined 表示这次预检失败 */
  preview?: PluginInstallPreview
  /** 预检失败时服务端给的提示 */
  previewError?: string
  /** 确认安装后的列表 */
  list: LocalPluginInfo[]
  calls: string[]
}

function serve(server: Fake) {
  return mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    server.calls.push(`${request.method} ${path}`)
    if (path === '/api/plugins/install/status') return Response.json({ available: true })
    if (path === '/api/catalog') return Response.json({ nodes: [] })
    if (path === '/api/plugins/local') return Response.json(server.list)
    if (path === '/api/plugins/install/preview') {
      if (server.previewError)
        return Response.json(
          { error: 'install_failed', message: server.previewError },
          { status: 400 },
        )
      return Response.json(server.preview ?? preview())
    }
    if (path === '/api/plugins/install/confirm') {
      server.list = [installed()]
      return Response.json(installed())
    }
    if (path.startsWith('/api/plugins/install/')) return new Response(null, { status: 204 })
  })
}

/** 选文件这一步是浏览器行为：这里直接给隐藏的 input 塞一个 ZIP */
function choose(file: File) {
  const input = screen.getByTestId('plugin-install-file')
  fireEvent.change(input, { target: { files: [file] } })
}

const zip = () =>
  new File([new Uint8Array([80, 75, 3, 4])], 'example.zip', { type: 'application/zip' })

describe('本机插件包的安装流程', () => {
  it('预检先展示清单与权限，确认后装上且默认禁用', async () => {
    const server: Fake = { list: [], calls: [] }
    serve(server)
    const { user } = renderApp(<LocalPlugins />)
    await screen.findByTestId('plugin-install-file')
    choose(zip())

    const dialog = await screen.findByRole('dialog', { name: '安装本机插件' })
    expect(dialog.textContent).toContain('安装示例 acme/install-ui')
    expect(dialog.textContent).toContain('acme/install-ui')
    expect(dialog.textContent).toContain('联网 example.com')
    expect(dialog.textContent).toContain('密钥 INSTALL_EXAMPLE_KEY')
    expect(dialog.textContent).toContain('未执行插件代码')

    await user.click(within(dialog).getByRole('button', { name: '确认安装（暂不启用）' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // 装上了但默认禁用：开关是关的
    const toggle = await screen.findByRole('switch', { name: '启用 安装示例 acme/install-ui' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('未启用')).toBeTruthy()
    expect(useCanvas.getState().notice).toContain('尚未启用')
  })

  it('取消预检会撤掉这次预检，什么都不装', async () => {
    const server: Fake = { list: [], calls: [] }
    serve(server)
    const { user } = renderApp(<LocalPlugins />)
    await screen.findByTestId('plugin-install-file')
    choose(zip())
    const dialog = await screen.findByRole('dialog', { name: '安装本机插件' })
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(server.calls.some((c) => c.startsWith('DELETE'))).toBe(true)
    expect(server.calls.some((c) => c.startsWith('POST /api/plugins/install/confirm'))).toBe(false)
  })

  it('预检失败把服务端的原因显示出来，不留下插件行', async () => {
    const server: Fake = { list: [], previewError: '插件 ID 已存在，不会覆盖安装', calls: [] }
    serve(server)
    renderApp(<LocalPlugins />)
    await screen.findByTestId('plugin-install-file')
    choose(zip())
    await screen.findByText('插件 ID 已存在，不会覆盖安装')
    expect(screen.queryByRole('dialog')).toBeNull()
    // 预检失败不留下任何插件行
    expect(document.querySelector('[data-plugin]')).toBeNull()
  })

  it('路径穿越的包预检失败，界面不出现可启用的插件', async () => {
    const server: Fake = { list: [], previewError: '包里有不安全路径：../outside.mjs', calls: [] }
    serve(server)
    renderApp(<LocalPlugins />)
    await screen.findByTestId('plugin-install-file')
    choose(zip())
    await screen.findByText('包里有不安全路径：../outside.mjs')
    expect(screen.queryByRole('switch')).toBeNull()
  })
})
