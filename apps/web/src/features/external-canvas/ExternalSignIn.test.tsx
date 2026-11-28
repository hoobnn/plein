// @vitest-environment happy-dom
import { API, externalAuthPath, type ExternalPlatform } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, screen, waitFor } from '../../testing/render'
import { ExternalCanvasDialog } from './ExternalCanvasDialog'

const canvasId = 'local-canvas'
const authorizationUrl = 'https://jimeng.jianying.com/ai-tool/device'
function pending(seconds: number) {
  return {
    status: 'pending',
    verificationUrl: authorizationUrl,
    expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
    userCode: 'TEST-CODE',
  }
}

it.each<ExternalPlatform>(['jimeng-canvas', 'jimeng-novel'])(
  '在 %s 未登录时启动官方授权，确认成功后仅重读原项目列表',
  async (provider) => {
    let signedIn = false,
      checks = 0,
      listings = 0
    const bodies: unknown[] = []
    mockFetch(async (req) => {
      const path = new URL(req.url).pathname
      if (path === API.externalCanvas(canvasId, 'targets')) return Response.json([])
      const body = await req.json()
      if (path === API.externalCanvas(canvasId, 'projects')) {
        listings++
        return signedIn
          ? Response.json([{ id: '123', title: '授权后的项目' }])
          : Response.json({ message: '需要登录' }, { status: 422 })
      }
      bodies.push(body)
      if (path === externalAuthPath(canvasId, 'start')) return Response.json(pending(60))
      if (path === externalAuthPath(canvasId, 'finish')) {
        if (++checks === 1) return Response.json(pending(60))
        signedIn = true
        return Response.json({ status: 'authenticated' })
      }
    })
    const { user } = renderApp(<ExternalCanvasDialog canvasId={canvasId} onClose={() => {}} />)
    if (provider === 'jimeng-novel') {
      await user.click(screen.getByRole('combobox', { name: '创作平台' }))
      await user.click(await screen.findByRole('option', { name: '即梦短剧' }))
    }
    await user.click(screen.getByRole('button', { name: '我的即梦项目' }))
    await user.click(await screen.findByRole('button', { name: '连接即梦账号' }))
    const link = await screen.findByRole('link', { name: '打开即梦授权页' })
    expect(link.getAttribute('href')).toBe(authorizationUrl)
    expect(screen.getByText('TEST-CODE')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '已授权，重新读取' }))
    expect(await screen.findByText(/即梦尚未确认授权/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '已授权，重新读取' }))
    expect(await screen.findByRole('combobox', { name: '我的即梦项目' })).toBeTruthy()
    expect(listings).toBe(2)
    expect(bodies).toEqual([{ provider }, { provider }, { provider }])
  },
)

it('过期链接需重新获取；核对期间切换平台会丢弃旧回执', async () => {
  let starts = 0,
    reads = 0
  let deliver!: (res: Response) => void
  const delayed = new Promise<Response>((resolve) => {
    deliver = resolve
  })
  let finishSignal: AbortSignal | undefined
  mockFetch((req) => {
    const path = new URL(req.url).pathname
    if (path === API.externalCanvas(canvasId, 'targets')) return Response.json([])
    if (path === API.externalCanvas(canvasId, 'projects')) {
      reads++
      return Response.json({ message: '需要登录' }, { status: 422 })
    }
    if (path === externalAuthPath(canvasId, 'start'))
      return Response.json(pending(++starts === 1 ? -30 : 60))
    if (path === externalAuthPath(canvasId, 'finish')) {
      finishSignal = req.signal
      return delayed
    }
  })
  const { user } = renderApp(<ExternalCanvasDialog canvasId={canvasId} onClose={() => {}} />)
  await user.click(screen.getByRole('button', { name: '我的即梦项目' }))
  await user.click(await screen.findByRole('button', { name: '连接即梦账号' }))
  expect(await screen.findByText(/授权链接已过期/)).toBeTruthy()
  expect(screen.queryByRole('link', { name: '打开即梦授权页' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '重新获取授权链接' }))
  await user.click(await screen.findByRole('button', { name: '已授权，重新读取' }))
  await waitFor(() => expect(finishSignal).toBeDefined())
  await user.click(screen.getByRole('combobox', { name: '创作平台' }))
  await user.click(screen.getByRole('option', { name: '即梦短剧' }))
  await waitFor(() => expect(finishSignal?.aborted).toBe(true))
  await act(async () => {
    deliver(Response.json({ status: 'authenticated' }))
    await delayed
  })
  expect(screen.queryByRole('link', { name: '打开即梦授权页' })).toBeNull()
  expect(reads).toBe(1)
})
