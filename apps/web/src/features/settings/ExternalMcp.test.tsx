// @vitest-environment happy-dom
import { expect, it, vi } from 'vite-plus/test'
import { queryKeys } from '../../api/query'
import { mockFetch } from '../../testing/fetch'
import { act, fireEvent, renderApp, screen, waitFor } from '../../testing/render'
import { ExternalMcp } from './ExternalMcp'

it('生成和关闭令牌直接同步状态，不重复读取状态接口', async () => {
  let enabled = false
  let reads = 0
  const fetch = mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path !== '/api/mcp/external') return
    if (request.method === 'GET') {
      reads++
      return Response.json({ enabled })
    }
    if (request.method === 'POST') {
      enabled = true
      return Response.json({ token: 'plein_test_token', createdAt: 123 })
    }
    if (request.method === 'DELETE') {
      enabled = false
      return new Response(null, { status: 204 })
    }
  })
  const { user } = renderApp(<ExternalMcp />)

  await user.click(await screen.findByRole('button', { name: '生成连接令牌' }))
  expect((await screen.findByTestId('external-mcp-config')).textContent).toContain(
    'plein_test_token',
  )
  expect(
    (await screen.findByRole<HTMLButtonElement>('button', { name: '重新生成令牌' })).disabled,
  ).toBe(false)

  await user.click(screen.getByRole('button', { name: '关闭' }))
  expect(
    (await screen.findByRole<HTMLButtonElement>('button', { name: '生成连接令牌' })).disabled,
  ).toBe(false)
  expect(screen.queryByTestId('external-mcp-config')).toBeNull()
  expect(reads).toBe(1)
  expect(fetch.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual([
    'GET',
    'POST',
    'DELETE',
  ])
})

it('生成失败保留关闭状态，提示后可重试', async () => {
  let attempts = 0
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path !== '/api/mcp/external') return
    if (request.method === 'GET') return Response.json({ enabled: false })
    if (request.method === 'POST' && ++attempts === 1)
      return Response.json(
        { error: 'test_failure', message: '暂时无法保存连接设置' },
        { status: 503 },
      )
    if (request.method === 'POST')
      return Response.json({ token: 'plein_retry_token', createdAt: 456 }, { status: 201 })
  })
  const { user } = renderApp(<ExternalMcp />)
  const issue = await screen.findByRole<HTMLButtonElement>('button', { name: '生成连接令牌' })

  await user.click(issue)
  expect((await screen.findByRole('alert')).textContent).toContain('暂时无法保存连接设置')
  expect(issue.disabled).toBe(false)
  expect(screen.queryByTestId('external-mcp-config')).toBeNull()

  await user.click(issue)
  expect((await screen.findByTestId('external-mcp-config')).textContent).toContain(
    'plein_retry_token',
  )
  expect(screen.queryByRole('alert')).toBeNull()
})

it('关闭失败保留配置和开启状态，提示后可重试', async () => {
  let deletes = 0
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path !== '/api/mcp/external') return
    if (request.method === 'GET') return Response.json({ enabled: true, createdAt: 123 })
    if (request.method === 'POST')
      return Response.json({ token: 'plein_keep_on_failure', createdAt: 456 }, { status: 201 })
    if (request.method === 'DELETE' && ++deletes === 1)
      return Response.json(
        { error: 'test_failure', message: '暂时无法保存连接设置' },
        { status: 503 },
      )
    if (request.method === 'DELETE') return new Response(null, { status: 204 })
  })
  const { user } = renderApp(<ExternalMcp />)
  await user.click(await screen.findByRole('button', { name: '重新生成令牌' }))
  const config = await screen.findByTestId('external-mcp-config')
  const before = config.textContent

  await user.click(screen.getByRole('button', { name: /^关闭$/ }))
  expect((await screen.findByRole('alert')).textContent).toContain('暂时无法保存连接设置')
  expect(config.textContent).toBe(before)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: /^关闭$/ }).disabled).toBe(false)

  await user.click(screen.getByRole('button', { name: /^关闭$/ }))
  expect(screen.queryByTestId('external-mcp-config')).toBeNull()
  expect(
    (await screen.findByRole<HTMLButtonElement>('button', { name: '生成连接令牌' })).disabled,
  ).toBe(false)
  expect(screen.queryByRole('alert')).toBeNull()
})

it('复制失败不显示成功，重试和客户端切换复制当前配置', async () => {
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path !== '/api/mcp/external') return
    if (request.method === 'GET') return Response.json({ enabled: false })
    if (request.method === 'POST')
      return Response.json({ token: 'plein_clipboard_token', createdAt: 123 }, { status: 201 })
  })
  const writeText = vi.fn<(text: string) => Promise<void>>()
  writeText
    .mockImplementationOnce(() => Promise.reject(new DOMException('Denied', 'NotAllowedError')))
    .mockImplementation(() => Promise.resolve())
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  try {
    const { user } = renderApp(<ExternalMcp />)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    await user.click(await screen.findByRole('button', { name: '生成连接令牌' }))
    const config = await screen.findByTestId('external-mcp-config')
    fireEvent.click(screen.getByRole('button', { name: /^复制$/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('复制失败')
    expect(screen.queryByRole('button', { name: /^已复制$/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^复制$/ }))
    expect(await screen.findByRole('button', { name: /^已复制$/ })).not.toBeNull()
    expect(writeText).toHaveBeenLastCalledWith(config.textContent)

    await user.click(screen.getByRole('button', { name: /^Cursor 等$/ }))
    expect(config.textContent).toContain('"mcpServers"')
    fireEvent.click(screen.getByRole('button', { name: /^复制$/ }))
    expect(writeText).toHaveBeenLastCalledWith(config.textContent)
    expect(screen.queryByRole('alert')).toBeNull()
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

it('读取状态时有反馈，失败可重试且不提前生成令牌', async () => {
  let respond!: (response: Response) => void
  let reads = 0
  mockFetch((request) => {
    if (new URL(request.url).pathname !== '/api/mcp/external' || request.method !== 'GET') return
    reads++
    if (reads === 1)
      return new Promise<Response>((resolve) => {
        respond = resolve
      })
    return Response.json({ enabled: true, createdAt: 123 })
  })
  const { user } = renderApp(<ExternalMcp />)
  expect(screen.getByRole('status').textContent).toContain('正在读取连接状态')
  expect(screen.queryByRole('button', { name: '生成连接令牌' })).toBeNull()
  await waitFor(() => expect(reads).toBe(1))
  await act(async () =>
    respond(Response.json({ error: 'unavailable', message: '连接暂时不可用' }, { status: 503 })),
  )
  expect((await screen.findByRole('alert')).textContent).toContain('连接暂时不可用')
  await user.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByRole('button', { name: '重新生成令牌' })).not.toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(reads).toBe(2)
})

it.each(['issue', 'revoke'] as const)('%s 成功后旧后台状态响应不能覆盖新状态', async (action) => {
  const wasEnabled = action === 'revoke'
  let reads = 0
  let release!: (response: Response) => void
  const oldResponse = new Promise<Response>((resolve) => {
    release = resolve
  })
  mockFetch((request) => {
    if (new URL(request.url).pathname !== '/api/mcp/external') return
    if (request.method === 'GET') {
      reads++
      return reads === 1 ? Response.json({ enabled: wasEnabled }) : oldResponse
    }
    if (request.method === 'POST')
      return Response.json({ token: 'plein_current_token', createdAt: 123 })
    if (request.method === 'DELETE') return new Response(null, { status: 204 })
  })
  const { user, queryClient } = renderApp(<ExternalMcp />)
  await screen.findByRole('button', { name: wasEnabled ? '重新生成令牌' : '生成连接令牌' })
  let refresh!: Promise<void>
  act(() => {
    refresh = queryClient.refetchQueries({ queryKey: queryKeys.mcpExternal })
  })
  await waitFor(() => expect(reads).toBe(2))
  await user.click(screen.getByRole('button', { name: wasEnabled ? '关闭' : '生成连接令牌' }))
  const currentLabel = wasEnabled ? '生成连接令牌' : '重新生成令牌'
  await screen.findByRole('button', { name: currentLabel })
  await act(async () => {
    release(Response.json({ enabled: wasEnabled }))
    await refresh
  })
  await waitFor(() =>
    expect(queryClient.getQueryData(queryKeys.mcpExternal)).toMatchObject({ enabled: !wasEnabled }),
  )
  expect(screen.getByRole('button', { name: currentLabel })).toBeTruthy()
  expect(reads).toBe(2)
})
