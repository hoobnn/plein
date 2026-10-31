// @vitest-environment happy-dom
import type { ProviderInfo } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { renderApp, screen, waitFor } from '../../testing/render'
import { RemoteModels } from './RemoteModels'

const provider = (over: Partial<ProviderInfo> = {}): ProviderInfo => ({
  id: 'acme/x',
  plugin: 'acme/p',
  title: '测试平台',
  enabled: true,
  configured: true,
  credentialCount: 1,
  settingsSchema: {},
  secrets: [],
  models: [{ id: 'known', title: '已知模型', capabilities: ['text.chat'] }],
  supportsRemoteModels: true,
  remoteModels: { fetchedAt: null, status: 'idle' },
  remoteModelsScope: ['text.chat'],
  ...over,
})

/** 列表只作候选的平台（如兼容渠道）：覆盖范围为空，schema 里声明了 datalist */
const candidateProvider = (): ProviderInfo => ({
  ...provider({ remoteModelsScope: [] }),
  settingsSchema: { properties: { model: { type: 'string', list: 'compatible-model-ids' } } },
})

function serve(refresh?: () => Response, config?: unknown) {
  return mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'POST' && path.includes('/remote-models/refresh'))
      return refresh?.() ?? Response.json({ fetchedAt: Date.now(), status: 'fresh' })
    if (path === '/api/providers/acme/x/config') return Response.json(config ?? {})
    return Response.json({}, { status: 404 })
  })
}

describe('远端模型列表区域', () => {
  it('平台不支持拉取时不渲染任何内容', () => {
    serve()
    const { container } = renderApp(
      <RemoteModels
        provider={provider({ supportsRemoteModels: undefined })}
        onRefreshed={() => {}}
      />,
    )
    expect(container.textContent).toBe('')
  })

  it('没拉取过时提示，刷新成功后回调父级重载目录', async () => {
    serve()
    let refreshed = 0
    const { user } = renderApp(
      <RemoteModels
        provider={provider()}
        onRefreshed={() => {
          refreshed += 1
        }}
      />,
    )
    expect(screen.getByText('还没有从平台拉取过模型列表')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '刷新模型列表' }))
    // 状态来自目录里的 provider.remoteModels：刷新成功后由父级重载目录带新 props
    await waitFor(() => expect(refreshed).toBe(1))
    expect(screen.queryByText(/失败/)).toBeNull()
  })

  it('刷新失败显示原因，不影响下次刷新', async () => {
    let fail = true
    serve(() =>
      fail
        ? Response.json({ error: 'invalid', message: '平台 502' }, { status: 502 })
        : Response.json({ fetchedAt: Date.now(), status: 'fresh' }),
    )
    const { user } = renderApp(<RemoteModels provider={provider()} onRefreshed={() => {}} />)
    await user.click(screen.getByRole('button', { name: '刷新模型列表' }))
    await waitFor(() => expect(screen.getByText(/刷新失败/)).toBeTruthy())
    fail = false
    await user.click(screen.getByRole('button', { name: '刷新模型列表' }))
    await waitFor(() => expect(screen.queryByText(/刷新失败/)).toBeNull())
  })

  it('过期的列表与上次失败原因如实显示', () => {
    serve()
    renderApp(
      <RemoteModels
        provider={provider({
          remoteModels: {
            fetchedAt: Date.now() - 25 * 60 * 60 * 1000,
            status: 'stale',
            error: '网络失败',
          },
        })}
        onRefreshed={() => {}}
      />,
    )
    expect(screen.getByText('列表已超过 24 小时，建议刷新')).toBeTruthy()
    expect(screen.getByText('上次刷新失败：网络失败')).toBeTruthy()
    expect(screen.getByText(/上次刷新：/)).toBeTruthy()
  })

  it('候选模式：datalist 按缓存候选渲染，刷新后取最新配置视图', async () => {
    serve(undefined, { remoteModelCandidates: [{ id: 'gpt-y' }] })
    let refreshed = 0
    const view = renderApp(
      <RemoteModels
        provider={candidateProvider()}
        candidates={[{ id: 'gpt-x', name: 'GPT X' }]}
        onRefreshed={() => {
          refreshed += 1
        }}
      />,
    )
    // datalist 选项不是可见控件，用容器断言
    const datalist = view.container.querySelector('#compatible-model-ids')
    expect(datalist?.querySelectorAll('option')).toHaveLength(1)
    expect(datalist?.querySelector('option')?.getAttribute('value')).toBe('gpt-x')
    expect(screen.getByText(/渠道返回 1 个模型/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '刷新模型列表' })).toBeNull()
    await view.user.click(screen.getByRole('button', { name: '刷新模型候选' }))
    await waitFor(() => expect(refreshed).toBe(1))
    // 刷新后候选来自刚取回的配置视图，不再显示旧缓存
    await waitFor(() => expect(screen.getByText(/渠道返回 1 个模型/)).toBeTruthy())
    expect(
      view.container.querySelector('#compatible-model-ids option')?.getAttribute('value'),
    ).toBe('gpt-y')
  })

  it('候选模式：还没有候选时提示先刷新', () => {
    serve()
    const view = renderApp(
      <RemoteModels provider={candidateProvider()} candidates={[]} onRefreshed={() => {}} />,
    )
    expect(view.container.querySelectorAll('datalist option')).toHaveLength(0)
    expect(screen.getByText(/还没拉取过/)).toBeTruthy()
  })
})
