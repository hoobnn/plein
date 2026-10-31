// @vitest-environment happy-dom
import type { Catalog } from '@plein/protocol'
import { describe, expect, it, vi } from 'vite-plus/test'
import { useAgent } from '../agent/store'
import { useCatalog } from '../../stores/catalog'
import { mockFetch } from '../../testing/fetch'
import { cleanup } from '@testing-library/react/pure'
import {
  act,
  fireEvent,
  renderApp,
  resetStoreAfterEach,
  screen,
  waitFor,
} from '../../testing/render'
import { SettingsDialog } from './Settings'

resetStoreAfterEach(useCatalog)
resetStoreAfterEach(useAgent)

const catalog = (over: Partial<Catalog> = {}): Catalog =>
  ({
    plugins: [],
    nodes: [],
    templates: [],
    prompts: [],
    elements: [],
    providers: [],
    defaultModels: {},
    ...over,
  }) as unknown as Catalog

const provider = {
  id: 'p/mock',
  plugin: 'p/mock',
  title: 'Mock 平台',
  enabled: true,
  configured: false,
  credentialCount: 0,
  settingsSchema: {
    type: 'object',
    properties: { note: { type: 'string', title: '备注' } },
  },
  secrets: [],
  models: [],
}

/** 设置对话框需要的接口 */
function serve(
  handlers: {
    catalog?(request: Request): Response
    config?(request: Request): Response
  } = {},
) {
  return mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path === '/api/catalog') return handlers.catalog?.(request) ?? Response.json(catalog())
    if (path.includes('/api/providers/') && path.endsWith('/config')) {
      console.log('--- config 请求', path)
      return (
        handlers.config?.(request) ?? Response.json({ enabled: true, settings: {}, secrets: {} })
      )
    }
    if (path === '/api/mcp/external') return Response.json({ available: false })
    if (path === '/api/plugins/local') return Response.json([])
    if (path === '/api/plugins/install/status') return Response.json({ available: false })
    if (path === '/api/agent') return Response.json({ agents: [] })
    return undefined
  })
}

const providerSection = () => screen.getByRole('button', { name: '模型平台' })
/** 平台区在 hidden 的容器里，按可访问性查不到；按 DOM 取它的输入框 */
const noteInput = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="备注"]') ??
  document.querySelector<HTMLInputElement>('input#:r:d:-field-note') ??
  document.querySelector<HTMLInputElement>('input.ui-input')!

/** 未配置平台的设置默认收在「更多设置」里：展开一次，已展开就不动 */
async function expandMore() {
  const more = await waitFor(() => screen.getByRole('button', { name: '更多设置' }))
  if (more.getAttribute('aria-expanded') === 'false') await userClick(more)
}

describe('设置对话框的生命周期', () => {
  it('切换分区后回来，未保存的草稿还在', async () => {
    serve({ catalog: () => Response.json(catalog({ providers: [provider] })) })
    renderApp(<SettingsDialog onClose={() => {}} />)

    await userClick(providerSection())
    await waitFor(() => expect(screen.getByText('已安装的平台')).toBeTruthy())
    const expand = await waitFor(() => {
      const b = screen
        .getAllByRole('button', { name: /Mock 平台/ })
        .find((x) => x.getAttribute('aria-expanded') !== null)
      if (!b) throw new Error('没有找到平台展开按钮')
      return b
    })
    await act(async () => {
      expand.click()
    })
    await expandMore()
    await waitFor(() => expect(noteInput()).toBeTruthy())
    fireEvent.change(noteInput(), { target: { value: '草稿内容' } })

    // 切到别的分区再回来
    await userClick(screen.getByRole('button', { name: '外观' }))
    await userClick(providerSection())
    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: '备注' }).value).toBe(
        '草稿内容',
      ),
    )
  })

  it('关闭对话框会丢弃未保存的草稿，重开后是已保存的值', async () => {
    let saved = { note: '已保存' }
    serve({
      catalog: () => Response.json(catalog({ providers: [provider] })),
      config: () => Response.json({ enabled: true, settings: saved, secrets: {} }),
    })
    const onClose = vi.fn()
    const view = renderApp(<SettingsDialog onClose={onClose} />)

    await userClick(providerSection())
    await waitFor(() => expect(screen.getByText('已安装的平台')).toBeTruthy())
    const expand = await waitFor(() => {
      const b = screen
        .getAllByRole('button', { name: /Mock 平台/ })
        .find((x) => x.getAttribute('aria-expanded') !== null)
      if (!b) throw new Error('没有找到平台展开按钮')
      return b
    })
    await act(async () => {
      expand.click()
    })
    await expandMore()
    await new Promise((r) => setTimeout(r, 50))
    await new Promise((r) => setTimeout(r, 100))
    await waitFor(() => expect(noteInput()).toBeTruthy())
    fireEvent.change(noteInput(), { target: { value: '没保存的草稿' } })

    // 关闭再打开
    view.unmount()
    cleanup()
    renderApp(<SettingsDialog onClose={onClose} />)
    await userClick(providerSection())
    await waitFor(() => expect(screen.getByText('已安装的平台')).toBeTruthy())
    const expand2 = await waitFor(() => {
      const b = screen
        .getAllByRole('button', { name: /Mock 平台/ })
        .find((x) => x.getAttribute('aria-expanded') !== null)
      if (!b) throw new Error('没有找到平台展开按钮')
      return b
    })
    await act(async () => {
      expand2.click()
    })
    await expandMore()
    await waitFor(() => expect(noteInput()).toBeTruthy())
    expect(noteInput().value).toBe('已保存')
    expect(saved.note).toBe('已保存')
  })

  it('分区切换后，迟到的配置读取不会串进重新展开的行', async () => {
    let release!: (response: Response) => void
    const gate = new Promise<Response>((resolve) => {
      release = resolve
    })
    let reads = 0
    mockFetch((request) => {
      const path = new URL(request.url).pathname
      if (path === '/api/catalog') return Response.json(catalog({ providers: [provider] }))
      if (path.includes('/config')) {
        reads++
        // 第一次读取挂住：等切走分区之后才回来
        if (reads === 1)
          return gate.then(() =>
            Response.json({ enabled: true, settings: { note: '迟到的值' }, secrets: {} }),
          )
        return Response.json({ enabled: true, settings: { note: '新读到的值' }, secrets: {} })
      }
      if (path === '/api/mcp/external') return Response.json({ available: false })
      if (path === '/api/plugins/local') return Response.json([])
      if (path === '/api/plugins/install/status') return Response.json({ available: false })
      if (path === '/api/agent') return Response.json({ agents: [] })
      return undefined
    })
    renderApp(<SettingsDialog onClose={() => {}} />)
    await userClick(providerSection())
    await waitFor(() => expect(screen.getByText('已安装的平台')).toBeTruthy())
    const expand = await waitFor(() => {
      const b = screen
        .getAllByRole('button', { name: /Mock 平台/ })
        .find((x) => x.getAttribute('aria-expanded') !== null)
      if (!b) throw new Error('没有找到平台展开按钮')
      return b
    })
    await act(async () => {
      expand.click()
    })

    // 切走分区：这一行被折叠，读取还挂着
    await userClick(screen.getByRole('button', { name: '外观' }))
    // 切回来并重新展开：这次读取拿到新值
    await userClick(providerSection())
    await waitFor(() => expect(screen.getByText('已安装的平台')).toBeTruthy())
    const expand2 = await waitFor(() => {
      const b = screen
        .getAllByRole('button', { name: /Mock 平台/ })
        .find((x) => x.getAttribute('aria-expanded') !== null)
      if (!b) throw new Error('没有找到平台展开按钮')
      return b
    })
    // 切回来时这一行仍是展开的，只有折叠了才需要再点一次
    if (expand2.getAttribute('aria-expanded') === 'false') {
      await act(async () => {
        expand2.click()
      })
    }
    await expandMore()
    await waitFor(() => expect(noteInput().value).toBe('新读到的值'))

    // 第一次读取这时才回来：不能把新读到的值覆盖掉
    expect(noteInput().value).toBe('新读到的值')
    // 确实读过两次：第一次迟到，第二次是新值
    expect(reads).toBe(2)
    // 第一次读取这时才回来
    release(Response.json({ enabled: true, settings: { note: '迟到的值' }, secrets: {} }))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    // 迟到应答落地后，新面板显示的值仍然来自第二次读取
    expect(noteInput().value).toBe('新读到的值')
  })
})

/** 点一个按钮并等 React 处理完 */
async function userClick(element: HTMLElement) {
  await act(async () => {
    element.click()
    await Promise.resolve()
  })
}
