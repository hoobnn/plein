// @vitest-environment happy-dom
import {
  REMOTE_MODELS_PULL_TIMEOUT_MS,
  type ProviderConfigView,
  type ProviderInfo,
} from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { renderApp, screen, waitFor } from '../../testing/render'
import { awaitRemoteModelsSettled, RemoteModels } from './RemoteModels'

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
        where="field"
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
      <RemoteModels
        where="field"
        provider={candidateProvider()}
        candidates={[]}
        onRefreshed={() => {}}
      />,
    )
    expect(view.container.querySelectorAll('datalist option')).toHaveLength(0)
    expect(screen.getByText(/还没拉取过/)).toBeTruthy()
  })

  it('后台拉取进行中显示「拉取中」，完成视图不再显示', () => {
    serve()
    const pulling = renderApp(<RemoteModels provider={provider()} pending onRefreshed={() => {}} />)
    expect(pulling.container.textContent).toContain('正在后台拉取模型列表')
    const done = renderApp(
      <RemoteModels
        provider={provider({ remoteModels: { fetchedAt: Date.now(), status: 'fresh' } })}
        onRefreshed={() => {}}
      />,
    )
    expect(done.container.textContent).not.toContain('正在后台拉取模型列表')
  })

  it('候选平台拉取中：提示拉取中并禁用手动刷新', () => {
    serve()
    const view = renderApp(
      <RemoteModels where="field" provider={candidateProvider()} pending onRefreshed={() => {}} />,
    )
    expect(view.container.textContent).toContain('正在后台拉取模型候选')
    expect(screen.getByRole('button', { name: '刷新模型候选' })).toHaveProperty('disabled', true)
  })

  it('awaitRemoteModelsSettled：轮询到 pending 消失为止，超时也带回最后视图', async () => {
    serve()
    const views: Array<Partial<ProviderConfigView> | undefined> = [
      { remoteModelsPending: true },
      { remoteModelsPending: true },
      {},
    ]
    let calls = 0
    const settled = await awaitRemoteModelsSettled('acme/x', {
      attempts: 5,
      delayMs: 0,
      getConfig: async () => views[Math.min(calls++, views.length - 1)],
    })
    expect(calls).toBe(3)
    expect(settled).toEqual({})
    calls = 0
    // 超时不再返回 null：带回最后一次视图（仍 pending），调用方据此刷新目录
    const timeout = await awaitRemoteModelsSettled('acme/x', {
      attempts: 2,
      delayMs: 0,
      getConfig: async () => ({ remoteModelsPending: true }),
    })
    expect(timeout).toEqual({ remoteModelsPending: true })
  })

  it('awaitRemoteModelsSettled：默认轮询窗口覆盖服务端拉取超时并留余量', async () => {
    serve()
    let calls = 0
    await awaitRemoteModelsSettled('acme/x', {
      delayMs: 0,
      getConfig: async () => {
        calls += 1
        return { remoteModelsPending: true }
      },
    })
    // 轮询总窗口 = (次数 - 1) × 间隔，须不小于服务端超时并留余量
    expect((calls - 1) * 1500).toBeGreaterThanOrEqual(REMOTE_MODELS_PULL_TIMEOUT_MS * 1.2)
  })

  it('awaitRemoteModelsSettled：中止后立即停止，不再发起新的读取', async () => {
    serve()
    const controller = new AbortController()
    let calls = 0
    const pending = awaitRemoteModelsSettled('acme/x', {
      delayMs: 0,
      signal: controller.signal,
      getConfig: async () => {
        calls += 1
        controller.abort()
        return { remoteModelsPending: true }
      },
    })
    const result = await pending
    expect(result).toBeNull()
    expect(calls).toBe(1)
  })

  it('挂载位互斥：候选平台不进标签区，合并平台不进字段旁', () => {
    serve()
    const candidatesAtTags = renderApp(
      <RemoteModels
        where="tags"
        provider={candidateProvider()}
        candidates={[{ id: 'gpt-x' }]}
        onRefreshed={() => {}}
      />,
    )
    expect(candidatesAtTags.container.textContent).toBe('')
    const mergeAtField = renderApp(
      <RemoteModels
        where="field"
        provider={provider({ remoteModels: { fetchedAt: Date.now(), status: 'fresh' } })}
        onRefreshed={() => {}}
      />,
    )
    expect(mergeAtField.container.textContent).toBe('')
  })
})
