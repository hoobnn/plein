// @vitest-environment happy-dom
import type { ProviderConfigView, ProviderInfo, ProviderTestResult } from '@plein/protocol'
import { useState } from 'react'
import { describe, expect, it } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { act, fireEvent, renderApp, screen, waitFor } from '../../testing/render'
import { ProviderRow } from './ProviderSettings'

const provider: ProviderInfo = {
  id: 'plein/mock',
  plugin: 'plein/mock',
  title: 'Mock（开发测试用）',
  description: '不联网的假平台',
  enabled: true,
  configured: false,
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
      queueMs: {
        type: 'integer',
        title: '其中平台排队（毫秒）',
        minimum: 0,
        maximum: 60_000,
        default: 0,
      },
      latencyPreset: {
        type: 'integer',
        title: '耗时档位',
        enum: [0, 100],
        default: 0,
      },
      failWith: {
        type: 'string',
        title: '模拟错误',
        enum: ['none', 'auth', 'rate_limit'],
        default: 'none',
      },
    },
  },
  secrets: [{ name: 'MOCK_API_KEY', title: 'API Key', help: 'mock 不校验密钥' }],
  models: [{ id: 'chat', title: 'Mock 对话', capabilities: ['text.chat'] }],
}

/** 兼容渠道：密钥、Base URL、模型 ID 与显式能力都在同一个表单里 */
const compatible: ProviderInfo = {
  id: 'plein/compatible',
  plugin: 'plein/compatible',
  title: '兼容对话渠道',
  description: '按 OpenAI 协议自建渠道',
  enabled: false,
  configured: false,
  testScope: 'configuration',
  settingsSchema: {
    type: 'object',
    properties: {
      baseURL: { type: 'string', title: 'Base URL', description: '包含 /v1 等协议前缀' },
      model: { type: 'string', title: '模型 ID' },
      vision: { type: 'boolean', title: '支持图片输入', default: false },
    },
  },
  secrets: [{ name: 'COMPATIBLE_API_KEY', title: 'API Key' }],
  models: [],
}

/** 平台配置视图：服务端只回报已保存的设置与密钥是否填写 */
const mockView = (
  settings: Record<string, unknown> = { latencyMs: 0, queueMs: 0, failWith: 'none' },
): ProviderConfigView => ({ enabled: true, settings, secrets: {} })

const testOk: ProviderTestResult = {
  ok: true,
  scope: 'connection',
  modelAccess: 'unverified',
  checkedAt: 1,
  message: '连接检查通过；尚未验证具体模型、资源权限或余额',
}

interface Handlers {
  get?(request: Request): Response | Promise<Response>
  put?(request: Request): Response | Promise<Response>
  test?(request: Request): Response | Promise<Response>
}

/** 平台行：展开后读配置、保存与检查都走真实 api client */
function renderRow(
  handlers: Handlers = {},
  {
    row = provider,
    settings = { latencyMs: 0, queueMs: 0, latencyPreset: 0, failWith: 'none' },
    onSaved = () => {},
  }: { row?: ProviderInfo; settings?: Record<string, unknown>; onSaved?(): void } = {},
) {
  const configPath = `/api/providers/${row.id}/config`
  const testPath = `/api/providers/${row.id}/test`
  const view = (): ProviderConfigView => mockView(settings)
  const fetch = mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    if (path === configPath)
      return request.method === 'GET'
        ? (handlers.get?.(request) ?? Response.json(view()))
        : (handlers.put?.(request) ?? Response.json(view()))
    if (path === testPath) return handlers.test?.(request) ?? Response.json(testOk)
    return undefined
  })
  function Harness() {
    const [open, setOpen] = useState(true)
    return (
      <ul>
        <ProviderRow
          provider={row}
          open={open}
          onToggleOpen={() => setOpen(!open)}
          onSaved={onSaved}
        />
      </ul>
    )
  }
  const { user } = renderApp(<Harness />)
  return { user, fetch }
}

/** 平台配置写入次数：用来证明恢复流程不重复保存 */
function writes(fetch: ReturnType<typeof mockFetch>) {
  return fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')
}

const latency = () => screen.getByRole<HTMLInputElement>('spinbutton', { name: '模拟耗时（毫秒）' })
const secret = () => screen.getByLabelText(/API Key/)
const toggle = () => screen.getByRole('button', { expanded: true })

describe('平台配置读取', () => {
  it('读取失败可在展开行内重试，成功后显示真实配置', async () => {
    let failing = true
    const { user } = renderRow({
      get: () =>
        failing
          ? Response.json({ error: 'test_failure', message: '配置暂不可用' }, { status: 503 })
          : Response.json(mockView()),
    })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('读取配置失败：配置暂不可用')

    await user.click(screen.getByRole('button', { name: '重试读取配置' }))
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBe(1))
    failing = false
    await user.click(screen.getByRole('button', { name: '重试读取配置' }))
    expect(
      (await screen.findByRole<HTMLInputElement>('spinbutton', { name: '模拟耗时（毫秒）' })).value,
    ).toBe('0')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: '重试读取配置' })).toBeNull()
  })

  it('折叠前发出的读取迟到时不能覆盖重开后的真实配置', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let late = false
    const { user } = renderRow({
      get: async () => {
        const value = late ? 987 : 0
        if (!late) await gate
        return Response.json(mockView({ latencyMs: value }))
      },
    })
    // 第一次读取还在路上：折叠后重开，读到的是新的真实配置
    await user.click(toggle())
    late = true
    await user.click(screen.getByRole('button', { expanded: false }))
    expect(
      (await screen.findByRole<HTMLInputElement>('spinbutton', { name: '模拟耗时（毫秒）' })).value,
    ).toBe('987')
    // 迟到的旧应答到达后不能改写已经显示的真实配置
    release()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(latency().value).toBe('987')
  })
})

describe('平台保存与检查', () => {
  it('检查成功后保存失败仍显示错误，重试保存真实写入', async () => {
    let failing = true
    const { user, fetch } = renderRow({
      put: async (request) =>
        failing
          ? Response.json({ error: 'test_failure', message: '保存暂不可用' }, { status: 503 })
          : Response.json(mockView((await request.json()).settings)),
    })
    await screen.findByRole<HTMLInputElement>('spinbutton', { name: '模拟耗时（毫秒）' })
    await user.click(screen.getByRole('button', { name: '测试连接' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('连接检查通过'))

    fireEvent.change(latency(), { target: { value: '321' } })
    fireEvent.focusOut(latency())
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('保存失败：保存暂不可用'),
    )
    expect(latency().value).toBe('321')

    failing = false
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已保存'))
    expect(writes(fetch)).toHaveLength(2)
    expect(JSON.parse(writes(fetch)[1]![1]!.body as string).settings.latencyMs).toBe(321)
  })

  it('修改配置或密钥后清除旧检查结果，未保存前不能检查', async () => {
    const { user } = renderRow({
      test: () =>
        Response.json({
          ok: false,
          scope: 'connection',
          modelAccess: 'unverified',
          checkedAt: 1,
          code: 'auth',
          message: '模拟：密钥无效',
        }),
    })
    await screen.findByRole<HTMLInputElement>('spinbutton', { name: '模拟耗时（毫秒）' })
    await user.click(screen.getByRole('button', { name: '测试连接' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('检查失败：模拟：密钥无效'),
    )

    await user.type(secret(), 'placeholder-key')
    expect(screen.queryByText('检查失败：模拟：密钥无效')).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '测试连接' }).disabled).toBe(true)
    expect(screen.getByText('修改尚未保存，请先保存再测试连接。')).toBeTruthy()
  })

  it('保存等待期间冻结输入，保存完成后才检查实际保存的配置', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { user, fetch } = renderRow({
      put: async (request) => {
        await gate
        return Response.json(mockView((await request.json()).settings))
      },
    })
    await screen.findByRole<HTMLInputElement>('spinbutton', { name: '模拟耗时（毫秒）' })
    fireEvent.change(latency(), { target: { value: '456' } })
    fireEvent.focusOut(latency())
    await user.type(secret(), 'placeholder-key')

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('处理中'))
    expect(latency().closest('fieldset')?.disabled).toBe(true)
    expect(secret().closest('fieldset')?.disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '测试连接' }).disabled).toBe(true)

    release()
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已保存'))
    expect(secret().getAttribute('value')).toBe('')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '测试连接' }).disabled).toBe(false)
    await user.click(screen.getByRole('button', { name: '测试连接' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('连接检查通过'))
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('检查请求传输失败与服务端检查结果分开显示', async () => {
    const { user } = renderRow({
      test: () =>
        Response.json({ error: 'unavailable', message: '检查服务暂不可用' }, { status: 503 }),
    })
    await screen.findByRole<HTMLInputElement>('spinbutton', { name: '模拟耗时（毫秒）' })
    await user.click(screen.getByRole('button', { name: '测试连接' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('检查请求失败：检查服务暂不可用'),
    )
    expect(screen.queryByText('连接检查通过；尚未验证具体模型、资源权限或余额')).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '测试连接' }).disabled).toBe(false)
  })
})

describe('平台数值校验', () => {
  it('未完成数字阻止保存，折叠不清除错误，修正后可保存', async () => {
    const { user, fetch } = renderRow()
    await screen.findByRole<HTMLInputElement>('spinbutton', { name: '模拟耗时（毫秒）' })
    fireEvent.change(latency(), { target: { value: '1e' } })
    expect(latency().validity.badInput).toBe(true)
    fireEvent.focusOut(latency())
    expect(latency().getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toContain('请输入有效数字')

    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(writes(fetch)).toHaveLength(0)
    expect(document.activeElement).toBe(latency())

    // 折叠再展开：无效状态与提示都还在
    await user.click(toggle())
    await user.click(screen.getByRole('button', { expanded: false }))
    expect(latency().getAttribute('aria-invalid')).toBe('true')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(writes(fetch)).toHaveLength(0)

    fireEvent.change(latency(), { target: { value: '123' } })
    fireEvent.focusOut(latency())
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已保存'))
    expect(writes(fetch)).toHaveLength(1)
  })

  it('回车先提交草稿，空值仍使用默认值，范围收拢后可以保存', async () => {
    const { user, fetch } = renderRow()
    await screen.findByRole<HTMLInputElement>('spinbutton', { name: '模拟耗时（毫秒）' })
    latency().focus()
    fireEvent.change(latency(), { target: { value: '60000.9' } })
    fireEvent.keyDown(latency(), { key: 'Enter' })
    await waitFor(() => expect(latency().value).toBe('60000'))
    expect(writes(fetch)).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已保存'))
    expect(JSON.parse(writes(fetch)[0]![1]!.body as string).settings.latencyMs).toBe(60000)

    fireEvent.change(latency(), { target: { value: '' } })
    fireEvent.focusOut(latency())
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(writes(fetch)).toHaveLength(2))
    expect(JSON.parse(writes(fetch)[1]![1]!.body as string).settings).not.toHaveProperty(
      'latencyMs',
    )
  })
})

describe('平台枚举设置', () => {
  it('枚举档位保存后仍是数字而不是字符串', async () => {
    const { user, fetch } = renderRow()
    await screen.findByRole('spinbutton', { name: '模拟耗时（毫秒）' })
    await user.click(screen.getByRole('combobox', { name: '耗时档位' }))
    await user.click(screen.getByRole('option', { name: '100' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已保存'))
    const body = JSON.parse(writes(fetch)[0]![1]!.body as string)
    expect(body.settings.latencyPreset).toBe(100)
    expect(typeof body.settings.latencyPreset).toBe('number')
  })
})

describe('兼容渠道表单', () => {
  it('密钥、Base URL、模型 ID 与显式能力一起提交', async () => {
    const { user, fetch } = renderRow({}, { row: compatible, settings: {} })
    await screen.findByLabelText(/API Key/)
    await user.type(screen.getByLabelText(/API Key/), 'test-only-not-a-real-key')
    await user.type(screen.getByLabelText('Base URL'), 'https://gateway.example.com/v1')
    await user.type(screen.getByLabelText('模型 ID'), 'example-chat')
    await user.click(screen.getByRole('checkbox', { name: '支持图片输入' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已保存'))

    const body = JSON.parse(writes(fetch)[0]![1]!.body as string)
    expect(body.settings).toEqual({
      baseURL: 'https://gateway.example.com/v1',
      model: 'example-chat',
      vision: true,
    })
    expect(body.secrets).toEqual({ COMPATIBLE_API_KEY: 'test-only-not-a-real-key' })
    // 没有远端鉴权探针的平台只做配置检查
    expect(screen.getByRole('button', { name: '检查配置' })).toBeTruthy()
  })
})

describe('平台草稿', () => {
  it('折叠再展开保留草稿且不自动保存', async () => {
    const { user, fetch } = renderRow()
    await screen.findByRole<HTMLInputElement>('spinbutton', { name: '模拟耗时（毫秒）' })
    fireEvent.change(latency(), { target: { value: '321' } })
    fireEvent.focusOut(latency())
    await user.type(secret(), 'unsaved-placeholder')

    await user.click(toggle())
    await user.click(screen.getByRole('button', { expanded: false }))
    expect(latency().value).toBe('321')
    expect(secret().getAttribute('value')).toBe('unsaved-placeholder')
    expect(writes(fetch)).toHaveLength(0)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '测试连接' }).disabled).toBe(true)
  })
})
