// @vitest-environment happy-dom
import type { ProviderConfigView, ProviderInfo, ProviderTestResult } from '@plein/protocol'
import { useState } from 'react'
import { describe, expect, it } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { act, fireEvent, renderApp, screen, waitFor, within } from '../../testing/render'
import { ProviderRow } from './ProviderSettings'

const provider: ProviderInfo = {
  id: 'plein/mock',
  plugin: 'plein/mock',
  title: 'Mock（开发测试用）',
  description: '不联网的假平台',
  enabled: true,
  configured: false,
  credentialCount: 0,
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
  credentialCount: 0,
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
): ProviderConfigView => ({
  enabled: true,
  settings,
  secrets: {},
  credentials: [],
  activeCredential: null,
})

/** 已保存的密钥组：服务端只回报标签与密钥是否已填写 */
const credential = (
  id: string,
  label: string,
  filled = false,
): ProviderConfigView['credentials'][number] => ({
  id,
  label,
  secrets: { MOCK_API_KEY: filled },
  secretHints: filled ? { MOCK_API_KEY: 'sk-••••••a1b2' } : {},
  configured: filled,
  usage: { tasks: 0, voices: 0 },
})

/** 带密钥组的配置视图：settings 默认与 mock 平台的已保存值一致 */
const credView = (
  credentials: ProviderConfigView['credentials'],
  activeCredential: string | null,
): ProviderConfigView => ({
  enabled: true,
  settings: { latencyMs: 0, queueMs: 0, latencyPreset: 0, failWith: 'none' },
  secrets: {},
  credentials,
  activeCredential,
})

const testOk: ProviderTestResult = {
  ok: true,
  scope: 'connection',
  modelAccess: 'unverified',
  checkedAt: 1,
  message: '连接检查通过；尚未验证具体模型、资源权限或余额',
}

/** 已配置好的平台：密钥组的用例都用它，摘要才能显示组标签 */
const configuredProvider: ProviderInfo = {
  ...provider,
  configured: true,
  credentialCount: 2,
  activeCredentialLabel: '个人',
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
    view,
  }: {
    row?: ProviderInfo
    settings?: Record<string, unknown>
    onSaved?(): void
    /** 替换默认的配置视图（带密钥组时用） */
    view?: ProviderConfigView
  } = {},
) {
  const configPath = `/api/providers/${row.id}/config`
  const testPath = `/api/providers/${row.id}/test`
  const current = (): ProviderConfigView => view ?? mockView(settings)
  const fetch = mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    if (path === configPath)
      return request.method === 'GET'
        ? (handlers.get?.(request) ?? Response.json(current()))
        : (handlers.put?.(request) ?? Response.json(current()))
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

/** 密钥区里指定组（组 id，或 'draft' 表示最后一张草稿卡）的查询范围 */
const card = (id: string) => {
  const list = screen.getByRole('list', { name: '密钥组' })
  const item =
    id === 'draft'
      ? [...list.querySelectorAll('li')].at(-1)
      : [...list.querySelectorAll('li')].find((li) => li.getAttribute('data-credential') === id)
  return within(item!)
}

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
    // 新平台没有已保存的组：密钥随预填的「默认」卡作为第一组创建
    expect(body.secrets).toBeUndefined()
    expect(body.credentials.add).toEqual([
      { label: '默认', secrets: { COMPATIBLE_API_KEY: 'test-only-not-a-real-key' } },
    ])
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

describe('密钥组', () => {
  /** 两组已保存的密钥：个人（当前使用）和团队 */
  const twoGroups = () =>
    credView([credential('cred-1', '个人', true), credential('cred-2', '团队', true)], 'cred-1')

  it('只有一组时不显示切换控件，标签留空表示不修改', async () => {
    const { user, fetch } = renderRow(
      {},
      { view: credView([credential('cred-1', '默认', true)], 'cred-1') },
    )
    expect(await screen.findByLabelText('「默认」的标签')).toBeTruthy()
    expect(screen.queryByText('使用中')).toBeNull()
    expect(screen.queryByRole('button', { name: '设为使用' })).toBeNull()
    expect(screen.getByRole('button', { name: '添加一组密钥' })).toBeTruthy()
    // 已填写的密钥只显示掩码，末四位可辨
    expect(card('cred-1').getByText('sk-••••••a1b2')).toBeTruthy()

    await user.type(card('cred-1').getByLabelText('「默认」的标签'), '个人')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已保存'))
    const body = JSON.parse(writes(fetch)[0]![1]!.body as string)
    expect(body.credentials.update).toEqual([{ id: 'cred-1', label: '个人' }])
  })

  it('只改密钥组时负载不带 settings，不把别的窗口保存的设置冲掉', async () => {
    const one = credView([credential('cred-1', '个人', true)], 'cred-1')
    const { user, fetch } = renderRow({}, { view: one })
    await screen.findByLabelText('「个人」的标签')
    // 本地没动设置（别的窗口可能刚改过并保存），只添加一组密钥
    await user.click(screen.getByRole('button', { name: '添加一组密钥' }))
    await user.type(card('draft').getByLabelText('「新密钥组 1」的API Key'), 'team-key')
    await user.type(card('draft').getByLabelText('「新密钥组 1」的标签'), '团队')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已保存'))
    const body = JSON.parse(writes(fetch)[0]![1]!.body as string)
    expect(body).not.toHaveProperty('settings')
    expect(body.credentials.add).toEqual([{ label: '团队', secrets: { MOCK_API_KEY: 'team-key' } }])
  })

  it('已保存组只填密钥即可保存，不需要标签', async () => {
    const { user, fetch } = renderRow({}, { row: configuredProvider, view: twoGroups() })
    await screen.findByLabelText('「个人」的标签')
    await user.click(card('cred-2').getByRole('button', { name: '更换「团队」的API Key' }))
    await user.type(card('cred-2').getByLabelText('「团队」的API Key'), 'new-key')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已保存'))
    const body = JSON.parse(writes(fetch)[0]![1]!.body as string)
    expect(body.credentials.update).toEqual([
      { id: 'cred-2', secrets: { MOCK_API_KEY: 'new-key' } },
    ])
  })

  it('已保存组输入与当前标签相同的值不算改动，不重复提交', async () => {
    const { user, fetch } = renderRow({}, { row: configuredProvider, view: twoGroups() })
    await screen.findByLabelText('「个人」的标签')
    await user.type(card('cred-2').getByLabelText('「团队」的标签'), ' 团队 ')
    // 与当前标签同值：不算未保存，行级检查也保持可用
    expect(screen.queryByText(/修改尚未保存/)).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '测试连接' }).disabled).toBe(false)
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已保存'))
    expect(JSON.parse(writes(fetch)[0]![1]!.body as string).credentials).toBeUndefined()
  })

  it('设置没保存时各卡的检查连接一并禁用', async () => {
    const { user } = renderRow(
      {
        // 保存后服务端存的就是提交的设置：回显才能回到未脏状态
        put: async (request) =>
          Response.json({ ...twoGroups(), settings: (await request.json()).settings }),
      },
      { row: configuredProvider, view: twoGroups() },
    )
    await screen.findByLabelText('「个人」的标签')
    expect(
      card('cred-1').getByRole<HTMLButtonElement>('button', { name: '检查「个人」的连接' })
        .disabled,
    ).toBe(false)
    fireEvent.change(latency(), { target: { value: '321' } })
    fireEvent.focusOut(latency())
    expect(
      card('cred-1').getByRole<HTMLButtonElement>('button', { name: '检查「个人」的连接' })
        .disabled,
    ).toBe(true)
    expect(
      card('cred-2').getByRole<HTMLButtonElement>('button', { name: '检查「团队」的连接' })
        .disabled,
    ).toBe(true)

    // 保存后恢复可用
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(
        card('cred-1').getByRole<HTMLButtonElement>('button', { name: '检查「个人」的连接' })
          .disabled,
      ).toBe(false),
    )
  })

  it('两组时标记当前组，卡片显示当前组标签，设为使用单独保存', async () => {
    const two = (activeId: string) =>
      credView([credential('cred-1', '个人', true), credential('cred-2', '团队', true)], activeId)
    let active = 'cred-1'
    const { user, fetch } = renderRow(
      {
        put: async (request) => {
          const body = await request.json()
          if (body.activeCredential) active = body.activeCredential
          return Response.json(two(active))
        },
      },
      { row: configuredProvider, view: two('cred-1') },
    )
    expect(await screen.findByText('已连接 · 个人')).toBeTruthy()
    expect(card('cred-1').getByText('使用中')).toBeTruthy()
    expect(card('cred-2').queryByText('使用中')).toBeNull()

    await user.click(card('cred-2').getByRole('button', { name: '设为使用「团队」' }))
    await waitFor(() => expect(card('cred-2').queryByText('使用中')).not.toBeNull())
    expect(JSON.parse(writes(fetch)[0]![1]!.body as string)).toEqual({
      activeCredential: 'cred-2',
    })
  })

  it('添加一组密钥：草稿卡保存时作为 credentials.add 提交', async () => {
    const one = credView([credential('cred-1', '个人', true)], 'cred-1')
    const { user, fetch } = renderRow(
      {
        put: async (request) =>
          Response.json(
            (await request.json()).credentials?.add
              ? credView(
                  [credential('cred-1', '个人', true), credential('cred-2', '团队', true)],
                  'cred-1',
                )
              : one,
          ),
      },
      { view: one },
    )
    await screen.findByLabelText('「个人」的标签')
    await user.click(screen.getByRole('button', { name: '添加一组密钥' }))
    // 多张草稿按序号命名，不重名
    expect(screen.getByLabelText('「新密钥组 1」的标签')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '添加一组密钥' }))
    expect(screen.getByLabelText('「新密钥组 2」的标签')).toBeTruthy()
    await user.click(card('draft').getByRole('button', { name: '移除「新密钥组 2」' }))
    await user.type(card('draft').getByLabelText('「新密钥组 1」的API Key'), 'key-2')
    await user.type(card('draft').getByLabelText('「新密钥组 1」的标签'), '团队')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已保存'))
    const body = JSON.parse(writes(fetch)[0]![1]!.body as string)
    expect(body.credentials.add).toEqual([{ label: '团队', secrets: { MOCK_API_KEY: 'key-2' } }])
    expect(body.credentials.update).toBeUndefined()
    // 保存后草稿卡变成已保存的组
    expect(card('cred-2').getByLabelText('「团队」的标签')).toBeTruthy()
  })

  it('新平台预填一张默认卡，没动过不提交，填完保存即创建第一组', async () => {
    const { user, fetch } = renderRow()
    const label = await screen.findByLabelText('「默认」的标签')
    expect(label).toBeTruthy()
    expect((label as HTMLInputElement).value).toBe('默认')

    // 只改设置：预填卡没动过，不作为新组提交
    fireEvent.change(latency(), { target: { value: '321' } })
    fireEvent.focusOut(latency())
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已保存'))
    expect(JSON.parse(writes(fetch)[0]![1]!.body as string).credentials).toBeUndefined()

    // 填了密钥：作为第一组提交
    await user.type(secret(), 'first-key')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(writes(fetch)).toHaveLength(2))
    expect(JSON.parse(writes(fetch)[1]![1]!.body as string).credentials.add).toEqual([
      { label: '默认', secrets: { MOCK_API_KEY: 'first-key' } },
    ])
  })

  it('新加的草稿卡没填标签时阻止保存并聚焦标签输入', async () => {
    const { user, fetch } = renderRow({}, { row: configuredProvider, view: twoGroups() })
    await screen.findByLabelText('「个人」的标签')
    await user.click(screen.getByRole('button', { name: '添加一组密钥' }))
    const label = screen.getByLabelText('「新密钥组 1」的标签')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(writes(fetch)).toHaveLength(0)
    expect(document.activeElement).toBe(label)
  })

  it('预填卡标签被清空后填了密钥：保存先要求补标签', async () => {
    const { user, fetch } = renderRow()
    const label = await screen.findByLabelText('「默认」的标签')
    fireEvent.change(label, { target: { value: '' } })
    await user.type(secret(), 'first-key')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(writes(fetch)).toHaveLength(0)
    expect(document.activeElement).toBe(label)
  })

  it('删掉已保存组和最后一张草稿后，预填卡重新出现', async () => {
    const one = credView([credential('cred-1', '个人', true)], 'cred-1')
    const { user } = renderRow(
      {
        put: async (request) => {
          const body = await request.json()
          return Response.json(
            body.credentials?.remove?.length
              ? { ...one, credentials: [], activeCredential: null }
              : one,
          )
        },
      },
      { row: configuredProvider, view: one },
    )
    await screen.findByLabelText('「个人」的标签')
    await user.click(screen.getByRole('button', { name: '添加一组密钥' }))
    await user.click(card('cred-1').getByRole('button', { name: '删除「个人」' }))
    await user.click(
      within(await screen.findByRole('dialog', { name: '删除密钥组「个人」？' })).getByRole(
        'button',
        { name: '删除' },
      ),
    )
    // 已保存组没了，剩一张手动加的草稿卡
    await waitFor(() => expect(card('draft').getByLabelText('「新密钥组 1」的标签')).toBeTruthy())

    await user.click(card('draft').getByRole('button', { name: '移除「新密钥组 1」' }))
    // 一个组都不剩：预填卡重新出现，新平台仍能创建第一组
    const seed = await screen.findByLabelText('「默认」的标签')
    expect((seed as HTMLInputElement).value).toBe('默认')
  })

  it('删除已保存的组需要确认，取消不发请求', async () => {
    const two = credView(
      [credential('cred-1', '个人', true), credential('cred-2', '团队', true)],
      'cred-1',
    )
    const { user, fetch } = renderRow(
      {
        put: async (request) => {
          const body = await request.json()
          return Response.json(
            body.credentials?.remove?.length
              ? credView([credential('cred-1', '个人', true)], 'cred-1')
              : two,
          )
        },
      },
      { view: two },
    )
    await screen.findByLabelText('「个人」的标签')
    await user.click(card('cred-2').getByRole('button', { name: '删除「团队」' }))
    const dialog = await screen.findByRole('dialog', { name: '删除密钥组「团队」？' })
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(writes(fetch)).toHaveLength(0)

    await user.click(card('cred-2').getByRole('button', { name: '删除「团队」' }))
    const second = await screen.findByRole('dialog', { name: '删除密钥组「团队」？' })
    await user.click(within(second).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(writes(fetch)).toHaveLength(1))
    expect(JSON.parse(writes(fetch)[0]![1]!.body as string).credentials.remove).toEqual(['cred-2'])
  })

  it('删除正在使用的组时提示会切到剩下的组', async () => {
    const two = credView(
      [credential('cred-1', '个人', true), credential('cred-2', '团队', true)],
      'cred-1',
    )
    const { user } = renderRow({ put: () => Response.json(two) }, { view: two })
    await screen.findByLabelText('「个人」的标签')
    await user.click(card('cred-1').getByRole('button', { name: '删除「个人」' }))
    const dialog = await screen.findByRole('dialog', { name: '删除密钥组「个人」？' })
    expect(dialog.textContent).toContain('删除后会改用「团队」的密钥')
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
  })

  it('删除前按使用情况说明后果，没有使用时保持简短确认', async () => {
    const two = credView(
      [
        { ...credential('cred-1', '个人', true), usage: { tasks: 2, voices: 3 } },
        credential('cred-2', '团队', true),
      ],
      'cred-1',
    )
    const { user } = renderRow({ put: () => Response.json(two) }, { view: two })
    await screen.findByLabelText('「个人」的标签')

    await user.click(card('cred-1').getByRole('button', { name: '删除「个人」' }))
    const dialog = await screen.findByRole('dialog', { name: '删除密钥组「个人」？' })
    expect(dialog.textContent).toContain('有 2 个任务的结果还没取回')
    expect(dialog.textContent).toContain('3 个音色属于这组 Key')
    expect(dialog.textContent).toContain('删除后这些结果无法再取回，这些音色也无法再配音')
    // 正在使用的组：后果之后仍说明会切换到哪一组
    expect(dialog.textContent).toContain('删除后会改用「团队」的密钥')
    await user.click(within(dialog).getByRole('button', { name: '取消' }))

    await user.click(card('cred-2').getByRole('button', { name: '删除「团队」' }))
    const short = await screen.findByRole('dialog', { name: '删除密钥组「团队」？' })
    expect(short.textContent).not.toContain('还没取回')
    expect(short.textContent).not.toContain('音色')
    await user.click(within(short).getByRole('button', { name: '取消' }))
  })

  it('多组时卡片按使用情况显示轻量摘要，单组或全为 0 时不显示', async () => {
    const two = credView(
      [
        { ...credential('cred-1', '个人', true), usage: { tasks: 2, voices: 3 } },
        credential('cred-2', '团队', true),
      ],
      'cred-1',
    )
    renderRow({}, { view: two })
    await screen.findByLabelText('「个人」的标签')
    expect(card('cred-1').getByText('2 个任务待取回 · 3 个音色')).toBeTruthy()
    expect(card('cred-2').queryByText(/待取回/)).toBeNull()
    expect(card('cred-2').queryByText(/音色/)).toBeNull()
  })

  it('单组时卡片不显示使用摘要，影响只在确认里说', async () => {
    const one = credView(
      [{ ...credential('cred-1', '个人', true), usage: { tasks: 2, voices: 3 } }],
      'cred-1',
    )
    renderRow({}, { view: one })
    await screen.findByLabelText('「个人」的标签')
    expect(card('cred-1').queryByText(/待取回/)).toBeNull()
    expect(card('cred-1').queryByText(/个音色/)).toBeNull()
  })

  it('卡片上的检查连接指定用那一组密钥，有没保存的输入时先禁用', async () => {
    const bodies: unknown[] = []
    const two = credView(
      [credential('cred-1', '个人', true), credential('cred-2', '团队', true)],
      'cred-1',
    )
    const { user } = renderRow(
      {
        test: async (request) => {
          bodies.push(await request.json())
          return Response.json(testOk)
        },
      },
      { view: two },
    )
    await screen.findByLabelText('「个人」的标签')
    await user.click(card('cred-2').getByRole('button', { name: '检查「团队」的连接' }))
    await waitFor(() => expect(bodies).toEqual([{ credential: 'cred-2' }]))

    // 这张卡填了没保存的密钥：先保存才能检查
    await user.click(card('cred-2').getByRole('button', { name: '更换「团队」的API Key' }))
    await user.type(card('cred-2').getByLabelText('「团队」的API Key'), 'new-key')
    expect(
      card('cred-2').getByRole<HTMLButtonElement>('button', { name: '检查「团队」的连接' })
        .disabled,
    ).toBe(true)
  })

  it('替换仍在使用的密钥前确认：仍然替换按 update 提交，取消不发请求', async () => {
    const two = credView(
      [
        { ...credential('cred-1', '个人', true), usage: { tasks: 2, voices: 3 } },
        credential('cred-2', '团队', true),
      ],
      'cred-1',
    )
    const { user, fetch } = renderRow({ put: () => Response.json(two) }, { view: two })
    await screen.findByLabelText('「个人」的标签')
    await user.click(card('cred-1').getByRole('button', { name: '更换「个人」的API Key' }))
    await user.type(card('cred-1').getByLabelText('「个人」的API Key'), 'brand-new-key')
    await user.click(screen.getByRole('button', { name: '保存' }))

    const dialog = await screen.findByRole('dialog', { name: '替换仍在使用的密钥？' })
    expect(dialog.textContent).toContain('「个人」：2 个任务待取回 · 3 个音色')
    expect(dialog.textContent).toContain(
      '如果新 Key 属于另一个账号，这些 Key 名下的结果和音色会失效',
    )
    expect(dialog.textContent).toContain('换账号建议「添加一组密钥」')
    // 初始焦点在推荐项「改为添加新组」上
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole('button', { name: '改为添加新组' }),
      ),
    )
    // 取消：不动任何东西
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(writes(fetch)).toHaveLength(0)

    // 仍然替换：按 update 提交
    await user.click(screen.getByRole('button', { name: '保存' }))
    const second = await screen.findByRole('dialog', { name: '替换仍在使用的密钥？' })
    await user.click(within(second).getByRole('button', { name: '仍然替换' }))
    await waitFor(() => expect(writes(fetch)).toHaveLength(1))
    expect(JSON.parse(writes(fetch)[0]![1]!.body as string).credentials.update).toEqual([
      { id: 'cred-1', secrets: { MOCK_API_KEY: 'brand-new-key' } },
    ])
  })

  it('同时改标签和 Key 后改为添加新组：原组标签退回，保存时不含原组 update', async () => {
    const two = credView(
      [
        { ...credential('cred-1', '个人', true), usage: { tasks: 0, voices: 2 } },
        credential('cred-2', '团队', true),
      ],
      'cred-1',
    )
    let added = false
    const { user, fetch } = renderRow(
      {
        put: async (request) => {
          const body = await request.json()
          if (body.credentials?.add?.length) added = true
          return Response.json(
            added
              ? credView(
                  [
                    { ...credential('cred-1', '个人', true), usage: { tasks: 0, voices: 2 } },
                    credential('cred-2', '团队', true),
                    credential('cred-3', '备用', true),
                  ],
                  'cred-1',
                )
              : two,
          )
        },
      },
      { view: two },
    )
    await screen.findByLabelText('「个人」的标签')
    // 同时改标签和 Key
    await user.type(card('cred-1').getByLabelText('「个人」的标签'), '家里')
    await user.click(card('cred-1').getByRole('button', { name: '更换「个人」的API Key' }))
    await user.type(card('cred-1').getByLabelText('「个人」的API Key'), 'moved-key')
    await user.click(screen.getByRole('button', { name: '保存' }))

    const dialog = await screen.findByRole('dialog', { name: '替换仍在使用的密钥？' })
    await user.click(within(dialog).getByRole('button', { name: '改为添加新组' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // 原组保持不变：标签草稿退回（输入为空 = 不修改），密钥输入清空
    expect((card('cred-1').getByLabelText('「个人」的标签') as HTMLInputElement).value).toBe('')
    expect(card('cred-1').queryByLabelText('「个人」的API Key')).toBeNull()
    expect(card('draft').getByLabelText('「新密钥组 1」的API Key').getAttribute('value')).toBe(
      'moved-key',
    )

    // 补上标签再保存：负载只有 credentials.add，原组不改名也不换 Key
    const label = card('draft').getByLabelText('「新密钥组 1」的标签') as HTMLInputElement
    expect(document.activeElement).toBe(label)
    await user.type(label, '备用')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(writes(fetch)).toHaveLength(1))
    const body = JSON.parse(writes(fetch)[0]![1]!.body as string)
    expect(body.credentials.add).toEqual([
      { label: '备用', secrets: { MOCK_API_KEY: 'moved-key' } },
    ])
    expect(body.credentials.update).toBeUndefined()
  })

  it('改为添加新组：刚输入的密钥移到新草稿卡并聚焦标签，原组不变，保存时按 add 提交', async () => {
    const two = credView(
      [
        { ...credential('cred-1', '个人', true), usage: { tasks: 0, voices: 2 } },
        credential('cred-2', '团队', true),
      ],
      'cred-1',
    )
    let replaced = false
    const { user, fetch } = renderRow(
      {
        put: async (request) => {
          const body = await request.json()
          if (body.credentials?.add?.length) replaced = true
          return Response.json(
            replaced
              ? credView(
                  [
                    { ...credential('cred-1', '个人', true), usage: { tasks: 0, voices: 2 } },
                    credential('cred-2', '团队', true),
                    credential('cred-3', '备用', true),
                  ],
                  'cred-1',
                )
              : two,
          )
        },
      },
      { view: two },
    )
    await screen.findByLabelText('「个人」的标签')
    await user.click(card('cred-1').getByRole('button', { name: '更换「个人」的API Key' }))
    await user.type(card('cred-1').getByLabelText('「个人」的API Key'), 'moved-key')
    await user.click(screen.getByRole('button', { name: '保存' }))

    const dialog = await screen.findByRole('dialog', { name: '替换仍在使用的密钥？' })
    await user.click(within(dialog).getByRole('button', { name: '改为添加新组' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // 没有发出保存：原组不变，刚输入的密钥落到新草稿卡，标签留空并聚焦
    expect(writes(fetch)).toHaveLength(0)
    const label = card('draft').getByLabelText('「新密钥组 1」的标签') as HTMLInputElement
    expect(label.value).toBe('')
    expect(document.activeElement).toBe(label)
    expect(card('cred-1').queryByLabelText('「个人」的API Key')).toBeNull()
    expect(card('draft').getByLabelText('「新密钥组 1」的API Key').getAttribute('value')).toBe(
      'moved-key',
    )

    // 补上标签再保存：负载是 credentials.add 而不是 update
    await user.type(label, '备用')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(writes(fetch)).toHaveLength(1))
    const body = JSON.parse(writes(fetch)[0]![1]!.body as string)
    expect(body.credentials.add).toEqual([
      { label: '备用', secrets: { MOCK_API_KEY: 'moved-key' } },
    ])
    expect(body.credentials.update).toBeUndefined()
  })

  it('多张使用中的卡一起替换：文案按组分行，一次确认作用于全部卡', async () => {
    const two = credView(
      [
        { ...credential('cred-1', '个人', true), usage: { tasks: 2, voices: 3 } },
        { ...credential('cred-2', '团队', true), usage: { tasks: 1, voices: 0 } },
      ],
      'cred-1',
    )
    const { user, fetch } = renderRow({ put: () => Response.json(two) }, { view: two })
    await screen.findByLabelText('「个人」的标签')
    await user.click(card('cred-1').getByRole('button', { name: '更换「个人」的API Key' }))
    await user.type(card('cred-1').getByLabelText('「个人」的API Key'), 'key-a')
    await user.click(card('cred-2').getByRole('button', { name: '更换「团队」的API Key' }))
    await user.type(card('cred-2').getByLabelText('「团队」的API Key'), 'key-b')
    await user.click(screen.getByRole('button', { name: '保存' }))

    const dialog = await screen.findByRole('dialog', { name: '替换仍在使用的密钥？' })
    expect(dialog.textContent).toContain('「个人」：2 个任务待取回 · 3 个音色')
    expect(dialog.textContent).toContain('「团队」：1 个任务待取回')
    await user.click(within(dialog).getByRole('button', { name: '仍然替换' }))
    await waitFor(() => expect(writes(fetch)).toHaveLength(1))
    expect(JSON.parse(writes(fetch)[0]![1]!.body as string).credentials.update).toEqual([
      { id: 'cred-1', secrets: { MOCK_API_KEY: 'key-a' } },
      { id: 'cred-2', secrets: { MOCK_API_KEY: 'key-b' } },
    ])
  })

  it('多张使用中的卡改为添加新组：各移一张草稿卡，原两组都没有 update', async () => {
    const two = credView(
      [
        { ...credential('cred-1', '个人', true), usage: { tasks: 2, voices: 0 } },
        { ...credential('cred-2', '团队', true), usage: { tasks: 0, voices: 1 } },
      ],
      'cred-1',
    )
    const { user, fetch } = renderRow({ put: () => Response.json(two) }, { view: two })
    await screen.findByLabelText('「个人」的标签')
    await user.click(card('cred-1').getByRole('button', { name: '更换「个人」的API Key' }))
    await user.type(card('cred-1').getByLabelText('「个人」的API Key'), 'key-a')
    await user.click(card('cred-2').getByRole('button', { name: '更换「团队」的API Key' }))
    await user.type(card('cred-2').getByLabelText('「团队」的API Key'), 'key-b')
    await user.click(screen.getByRole('button', { name: '保存' }))

    const dialog = await screen.findByRole('dialog', { name: '替换仍在使用的密钥？' })
    await user.click(within(dialog).getByRole('button', { name: '改为添加新组' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(writes(fetch)).toHaveLength(0)
    // 每张卡各移一张草稿卡，原组的输入全部退回
    expect(screen.getByLabelText('「新密钥组 1」的API Key').getAttribute('value')).toBe('key-a')
    expect(screen.getByLabelText('「新密钥组 2」的API Key').getAttribute('value')).toBe('key-b')
    expect((screen.getByLabelText('「个人」的标签') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('「团队」的标签') as HTMLInputElement).value).toBe('')

    // 补齐两张标签再保存：只有 add，原两组不动
    await user.type(screen.getByLabelText('「新密钥组 1」的标签'), '备用一')
    await user.type(screen.getByLabelText('「新密钥组 2」的标签'), '备用二')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(writes(fetch)).toHaveLength(1))
    const body = JSON.parse(writes(fetch)[0]![1]!.body as string)
    expect(body.credentials.add).toEqual([
      { label: '备用一', secrets: { MOCK_API_KEY: 'key-a' } },
      { label: '备用二', secrets: { MOCK_API_KEY: 'key-b' } },
    ])
    expect(body.credentials.update).toBeUndefined()
  })

  it('确认前重新读取最新 usage：缓存为 0 时删除也提示影响', async () => {
    const cached = credView(
      [credential('cred-1', '个人', true), credential('cred-2', '团队', true)],
      'cred-1',
    )
    const fresh = credView(
      [
        { ...credential('cred-1', '个人', true), usage: { tasks: 2, voices: 0 } },
        credential('cred-2', '团队', true),
      ],
      'cred-1',
    )
    let reads = 0
    const { user } = renderRow(
      {
        get: () => {
          reads++
          return Response.json(reads === 1 ? cached : fresh)
        },
      },
      { view: cached },
    )
    await screen.findByLabelText('「个人」的标签')
    // 缓存里的 usage 是 0，卡片上没有摘要；确认前重新读取才发现有未取回的结果
    expect(card('cred-1').queryByText(/待取回/)).toBeNull()
    await user.click(card('cred-1').getByRole('button', { name: '删除「个人」' }))
    const dialog = await screen.findByRole('dialog', { name: '删除密钥组「个人」？' })
    expect(dialog.textContent).toContain('有 2 个任务的结果还没取回')
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
  })

  it('确认前重新读取最新 usage：缓存为 0 时替换也弹确认，草稿不被覆盖', async () => {
    const cached = credView(
      [credential('cred-1', '个人', true), credential('cred-2', '团队', true)],
      'cred-1',
    )
    const fresh = credView(
      [
        { ...credential('cred-1', '个人', true), usage: { tasks: 0, voices: 2 } },
        credential('cred-2', '团队', true),
      ],
      'cred-1',
    )
    let reads = 0
    const { user, fetch } = renderRow(
      {
        get: () => {
          reads++
          return Response.json(reads === 1 ? cached : fresh)
        },
      },
      { view: cached },
    )
    await screen.findByLabelText('「个人」的标签')
    await user.click(card('cred-1').getByRole('button', { name: '更换「个人」的API Key' }))
    await user.type(card('cred-1').getByLabelText('「个人」的API Key'), 'brand-new-key')
    await user.click(screen.getByRole('button', { name: '保存' }))

    const dialog = await screen.findByRole('dialog', { name: '替换仍在使用的密钥？' })
    expect(dialog.textContent).toContain('「个人」：2 个音色')
    // 取消：刚输入的密钥还在，服务端数据已同步但不覆盖草稿
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(writes(fetch)).toHaveLength(0)
    expect((card('cred-1').getByLabelText('「个人」的API Key') as HTMLInputElement).value).toBe(
      'brand-new-key',
    )
  })

  it('重新读取配置失败时退回缓存值照常进行，不阻断', async () => {
    const cached = credView(
      [credential('cred-1', '个人', true), credential('cred-2', '团队', true)],
      'cred-1',
    )
    let reads = 0
    const { user, fetch } = renderRow(
      {
        get: () => {
          reads++
          return reads === 1
            ? Response.json(cached)
            : Response.json({ error: 'unavailable', message: '暂不可用' }, { status: 503 })
        },
      },
      { view: cached },
    )
    await screen.findByLabelText('「个人」的标签')
    // 删除：拿不到最新值就按缓存（usage 0）给简短确认
    await user.click(card('cred-1').getByRole('button', { name: '删除「个人」' }))
    const dialog = await screen.findByRole('dialog', { name: '删除密钥组「个人」？' })
    expect(dialog.textContent).not.toContain('还没取回')
    await user.click(within(dialog).getByRole('button', { name: '取消' }))

    // 替换：同样不弹确认，直接保存
    await user.click(card('cred-2').getByRole('button', { name: '更换「团队」的API Key' }))
    await user.type(card('cred-2').getByLabelText('「团队」的API Key'), 'fresh-key')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(writes(fetch)).toHaveLength(1))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('平台带文档链接时在密钥区给出「获取密钥」外链', async () => {
    renderRow({}, { row: { ...provider, docsUrl: 'https://example.com/keys' } })
    const link = await screen.findByRole('link', { name: '获取密钥' })
    expect(link.getAttribute('href')).toBe('https://example.com/keys')
    expect(link.getAttribute('rel')).toBe('noreferrer')
  })

  it('密钥粘贴自动去掉首尾空白，回车直接提交', async () => {
    const { fetch } = renderRow()
    const input = await screen.findByLabelText('「默认」的API Key')
    fireEvent.change(input, { target: { value: '  first-key  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已保存'))
    expect(JSON.parse(writes(fetch)[0]![1]!.body as string).credentials.add).toEqual([
      { label: '默认', secrets: { MOCK_API_KEY: 'first-key' } },
    ])
  })

  it('密钥输入可以在明文与掩码之间切换', async () => {
    renderRow()
    const input = await screen.findByLabelText('「默认」的API Key')
    expect(input.getAttribute('type')).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: '显示「默认」的密钥' }))
    expect(input.getAttribute('type')).toBe('text')
    fireEvent.click(screen.getByRole('button', { name: '隐藏「默认」的密钥' }))
    expect(input.getAttribute('type')).toBe('password')
  })

  it('已保存的密钥显示掩码，更换就地展开，取消恢复掩码', async () => {
    const one = credView([credential('cred-1', '个人', true)], 'cred-1')
    const { user } = renderRow({}, { view: one })
    await screen.findByLabelText('「个人」的标签')
    expect(card('cred-1').getByText('sk-••••••a1b2')).toBeTruthy()
    expect(card('cred-1').queryByLabelText('「个人」的API Key')).toBeNull()

    await user.click(card('cred-1').getByRole('button', { name: '更换「个人」的API Key' }))
    await user.type(card('cred-1').getByLabelText('「个人」的API Key'), 'new-key')
    await user.click(card('cred-1').getByRole('button', { name: '取消更换「个人」的密钥' }))
    // 取消后回到掩码，刚输入的密钥不再显示
    expect(card('cred-1').queryByLabelText('「个人」的API Key')).toBeNull()
    expect(card('cred-1').getByText('sk-••••••a1b2')).toBeTruthy()
  })

  it('未配置平台的「保存并校验」保存后立即校验，结果就地显示', async () => {
    const { user, fetch } = renderRow()
    await user.type(await screen.findByLabelText('「默认」的API Key'), 'first-key')
    await user.click(screen.getByRole('button', { name: '保存并校验' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('连接检查通过'))
    expect(writes(fetch)).toHaveLength(1)
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('校验失败后状态徽章变成「校验失败」，卡片上的重新校验只用这一组', async () => {
    const two = credView(
      [credential('cred-1', '个人', true), credential('cred-2', '团队', true)],
      'cred-1',
    )
    const { user } = renderRow(
      {
        test: () =>
          Response.json({
            ok: false,
            scope: 'connection',
            modelAccess: 'unverified',
            checkedAt: 1,
            code: 'auth',
            message: '密钥无效',
          }),
      },
      { row: configuredProvider, view: two },
    )
    await screen.findByLabelText('「个人」的标签')
    await user.click(card('cred-2').getByRole('button', { name: '检查「团队」的连接' }))
    await waitFor(() => expect(screen.getByText('校验失败')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toBe('检查失败：密钥无效')
  })

  it('替换没有使用的密钥组不打扰，直接保存', async () => {
    const two = credView(
      [credential('cred-1', '个人', true), credential('cred-2', '团队', true)],
      'cred-1',
    )
    const { user, fetch } = renderRow({ put: () => Response.json(two) }, { view: two })
    await screen.findByLabelText('「个人」的标签')
    await user.click(card('cred-2').getByRole('button', { name: '更换「团队」的API Key' }))
    await user.type(card('cred-2').getByLabelText('「团队」的API Key'), 'fresh-key')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(writes(fetch)).toHaveLength(1))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(JSON.parse(writes(fetch)[0]![1]!.body as string).credentials.update).toEqual([
      { id: 'cred-2', secrets: { MOCK_API_KEY: 'fresh-key' } },
    ])
  })
})
