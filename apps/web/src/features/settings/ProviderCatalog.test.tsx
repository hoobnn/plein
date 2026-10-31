// @vitest-environment happy-dom
import type { Catalog, ProviderInfo } from '@plein/protocol'
import { useEffect, useState } from 'react'
import { beforeEach, describe, expect, it } from 'vite-plus/test'
import { useCatalog } from '../../stores/catalog'
import { mockFetch } from '../../testing/fetch'
import { fireEvent, renderApp, resetStoreAfterEach, screen, waitFor } from '../../testing/render'
import { ProviderSettings } from './ProviderSettings'

resetStoreAfterEach(useCatalog)

const configPath = '/api/providers/plein/mock/config'
const modelPath = '/api/model-defaults'

const provider: ProviderInfo = {
  id: 'plein/mock',
  plugin: 'plein/mock',
  title: 'Mock（开发测试用）',
  description: '不联网的假平台',
  enabled: true,
  configured: true,
  credentialCount: 1,
  testScope: 'connection',
  settingsSchema: {
    type: 'object',
    properties: {
      latencyMs: {
        type: 'integer',
        title: '模拟耗时（毫秒）',
        minimum: 0,
        maximum: 60_000,
        default: 0,
      },
    },
  },
  secrets: [{ name: 'MOCK_API_KEY', title: 'API Key' }],
  models: [
    { id: 'agent', title: 'Mock 智能体', capabilities: ['text.chat'] },
    { id: 'chat', title: 'Mock 对话', capabilities: ['text.chat'] },
    { id: 'legacy', title: '弃用对话', capabilities: ['text.chat'], deprecated: true },
    { id: 'image', title: 'Mock 图片', capabilities: ['image.generate'] },
  ],
}

/** 服务端状态：目录、平台配置与默认模型都从这里读 */
interface State {
  enabled: boolean
  settings: Record<string, unknown>
  defaultModel: string
}

const state: State = {
  enabled: true,
  settings: { latencyMs: 0 },
  defaultModel: 'plein/mock:agent',
}

beforeEach(() => {
  state.enabled = true
  state.settings = { latencyMs: 0 }
  state.defaultModel = 'plein/mock:agent'
})

const catalogOf = (): Catalog => ({
  plugins: [],
  nodes: [],
  templates: [],
  prompts: [],
  elements: [],
  defaultModels: { 'text.chat': state.defaultModel },
  providers: [{ ...provider, enabled: state.enabled }],
})

/** 目录读取失败时保留上次的目录，已完成的保存不重复写入 */
function setup({ failing = false }: { failing?: boolean } = {}) {
  let catalogFailing = failing
  const writes: string[] = []
  const fetch = mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    if (path === '/api/catalog') {
      if (catalogFailing)
        return Response.json(
          { error: 'test_failure', message: '平台目录暂不可用' },
          { status: 503 },
        )
      return Response.json(catalogOf())
    }
    if (path === configPath) {
      if (request.method === 'PUT') {
        const body = (await request.json()) as {
          enabled?: boolean
          settings?: Record<string, unknown>
        }
        writes.push('config')
        if (body.enabled !== undefined) state.enabled = body.enabled
        if (body.settings) state.settings = body.settings
        return Response.json({ enabled: state.enabled, settings: state.settings, secrets: {} })
      }
      return Response.json({ enabled: state.enabled, settings: state.settings, secrets: {} })
    }
    if (path === modelPath) {
      const body = (await request.json()) as { model: string }
      writes.push('model')
      state.defaultModel = body.model
      return Response.json({ defaultModels: { 'text.chat': state.defaultModel } })
    }
    return undefined
  })
  return {
    fetch,
    writes,
    failCatalog() {
      catalogFailing = true
    },
    recoverCatalog() {
      catalogFailing = false
    },
  }
}

/** 设置里的模型平台分区：和真实设置弹窗一样读目录、保留上次结果 */
function SettingsHarness() {
  const { catalog, error, load } = useCatalog()
  const [openProvider, setOpenProvider] = useState<string | null>(null)
  useEffect(() => {
    void load()
  }, [load])
  return (
    <ProviderSettings
      catalog={catalog}
      catalogError={error}
      load={load}
      openProvider={openProvider}
      onToggleOpen={(id) => setOpenProvider(openProvider === id ? null : id)}
    />
  )
}

const disabled = (element: HTMLElement) =>
  element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true'

const latency = () => screen.getByRole<HTMLInputElement>('spinbutton', { name: '模拟耗时（毫秒）' })

describe('平台目录恢复', () => {
  it('配置已保存但目录读取失败时保留界面，独立重试不重复写入', async () => {
    const app = setup()
    const { user } = renderApp(<SettingsHarness />)
    await screen.findByRole('combobox', { name: '默认文本模型' })

    app.failCatalog()
    await user.click(screen.getByRole('button', { expanded: false }))
    await screen.findByRole('spinbutton', { name: '模拟耗时（毫秒）' })
    fireEvent.change(latency(), { target: { value: '321' } })
    fireEvent.focusOut(latency())
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('平台目录暂不可用'))
    expect(screen.getByText('当前显示上次读取的目录；已完成的保存无需重复。')).toBeTruthy()
    expect(disabled(screen.getByRole('combobox', { name: '默认文本模型' }))).toBe(true)
    expect(disabled(screen.getByRole('switch'))).toBe(true)
    expect(disabled(screen.getByRole('button', { name: '保存' }))).toBe(true)
    expect(latency().value).toBe('321')

    // 目录还没恢复，重试只重新读目录，不重复写入已完成的保存
    await user.click(screen.getByRole('button', { name: '重试更新平台目录' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '重试更新平台目录' }).hasAttribute('disabled'),
      ).toBe(false),
    )
    expect(app.writes).toEqual(['config'])

    app.recoverCatalog()
    await user.click(screen.getByRole('button', { name: '重试更新平台目录' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(disabled(screen.getByRole('switch'))).toBe(false)
    expect(app.writes).toEqual(['config'])
  })

  it('默认模型已保存但目录读取失败时保留选择，重试不重复保存', async () => {
    const app = setup()
    const { user } = renderApp(<SettingsHarness />)
    await screen.findByRole('combobox', { name: '默认文本模型' })

    app.failCatalog()
    await user.click(screen.getByRole('combobox', { name: '默认文本模型' }))
    await user.click(screen.getByRole('option', { name: 'Mock（开发测试用） · Mock 对话' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('平台目录暂不可用'))
    expect(screen.getByRole('combobox', { name: '默认文本模型' }).textContent).toContain(
      'Mock 智能体',
    )

    await user.click(screen.getByRole('button', { name: '重试更新平台目录' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '重试更新平台目录' }).hasAttribute('disabled'),
      ).toBe(false),
    )
    expect(app.writes).toEqual(['model'])

    app.recoverCatalog()
    await user.click(screen.getByRole('button', { name: '重试更新平台目录' }))
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '默认文本模型' }).textContent).toContain(
        'Mock 对话',
      ),
    )
    expect(app.writes).toEqual(['model'])
  })
})

describe('默认模型', () => {
  it('弃用模型不出现在默认模型候选中', async () => {
    setup()
    const { user } = renderApp(<SettingsHarness />)
    const trigger = await screen.findByRole('combobox', { name: '默认文本模型' })
    await user.click(trigger)

    expect(screen.getByRole('option', { name: 'Mock（开发测试用） · Mock 对话' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Mock（开发测试用） · 弃用对话' })).toBeNull()
  })

  it('保存失败保留原选择，重新选择可真实保存', async () => {
    let failing = true
    mockFetch(async (request) => {
      const path = new URL(request.url).pathname
      if (path === '/api/catalog') return Response.json(catalogOf())
      if (path === modelPath) {
        if (failing)
          return Response.json(
            { error: 'test_failure', message: '默认模型暂不可保存' },
            { status: 503 },
          )
        const body = (await request.json()) as { model: string }
        state.defaultModel = body.model
        return Response.json({ defaultModels: { 'text.chat': state.defaultModel } })
      }
      return undefined
    })
    const { user } = renderApp(<SettingsHarness />)
    await screen.findByRole('combobox', { name: '默认文本模型' })

    await user.click(screen.getByRole('combobox', { name: '默认文本模型' }))
    await user.click(screen.getByRole('option', { name: 'Mock（开发测试用） · Mock 对话' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('默认模型暂不可保存'),
    )
    expect(screen.getByRole('combobox', { name: '默认文本模型' }).textContent).toContain(
      'Mock 智能体',
    )
    expect(disabled(screen.getByRole('combobox', { name: '默认文本模型' }))).toBe(false)

    failing = false
    await user.click(screen.getByRole('combobox', { name: '默认文本模型' }))
    await user.click(screen.getByRole('option', { name: 'Mock（开发测试用） · Mock 对话' }))
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '默认文本模型' }).textContent).toContain(
        'Mock 对话',
      ),
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('等待保存和目录刷新时锁定当前选择，其他能力不受影响', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mockFetch(async (request) => {
      const path = new URL(request.url).pathname
      if (path === '/api/catalog') return Response.json(catalogOf())
      if (path === modelPath) {
        const body = (await request.json()) as { model: string }
        await gate
        state.defaultModel = body.model
        return Response.json({ defaultModels: { 'text.chat': state.defaultModel } })
      }
      return undefined
    })
    const { user } = renderApp(<SettingsHarness />)
    await screen.findByRole('combobox', { name: '默认文本模型' })

    await user.click(screen.getByRole('combobox', { name: '默认文本模型' }))
    await user.click(screen.getByRole('option', { name: 'Mock（开发测试用） · Mock 对话' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('正在保存文本默认模型'),
    )
    expect(disabled(screen.getByRole('combobox', { name: '默认文本模型' }))).toBe(true)
    expect(disabled(screen.getByRole('combobox', { name: '默认图像模型' }))).toBe(false)

    release()
    await waitFor(() =>
      expect(disabled(screen.getByRole('combobox', { name: '默认文本模型' }))).toBe(false),
    )
  })
})
