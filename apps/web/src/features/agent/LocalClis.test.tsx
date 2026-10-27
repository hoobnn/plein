// @vitest-environment happy-dom
import type { LocalCliInfo } from '@plein/protocol'
import { expect, it, vi } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, screen } from '../../testing/render'
import { LocalClis } from './LocalClis'

const cli: LocalCliInfo = {
  id: 'codex',
  name: 'Codex',
  installed: false,
  loggedIn: null,
  updateAvailable: false,
  installCommand: 'npm install -g @example/codex',
  loginCommand: 'codex login',
}

async function setup() {
  mockFetch((request) => {
    if (request.method === 'GET' && new URL(request.url).pathname === '/api/agent/clis')
      return Response.json([cli])
  })
  vi.useFakeTimers()
  const view = renderApp(<LocalClis />)
  const copy = await screen.findByRole('button', { name: '复制' })
  return { ...view, copy }
}

it('剪贴板拒绝写入时说明复制失败，不显示已复制', async () => {
  const { user, copy } = await setup()
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('权限被拒绝'))
  await user.click(copy)
  expect(await screen.findByRole('button', { name: '复制失败' })).toBe(copy)
  expect(screen.queryByRole('button', { name: '已复制' })).toBeNull()
  expect(screen.getByRole('alert').textContent).toContain('请选中命令手动复制')
})

it('复制成功后短暂反馈并恢复，可以再次复制', async () => {
  const { user, copy } = await setup()
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  await user.click(copy)
  expect(writeText).toHaveBeenCalledWith(cli.installCommand)
  expect(screen.getByRole('button', { name: '已复制' })).toBe(copy)
  await act(() => vi.advanceTimersByTimeAsync(1500))
  expect(screen.getByRole('button', { name: '复制' })).toBe(copy)
  await user.click(copy)
  expect(writeText).toHaveBeenCalledTimes(2)
  await act(() => vi.advanceTimersByTimeAsync(1500))
})
