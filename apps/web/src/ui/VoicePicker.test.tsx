// @vitest-environment happy-dom
import { useLayoutEffect, useState } from 'react'
import { noVoice, type VoiceRef } from '@plein/nodes'
import { expect, it, vi } from 'vite-plus/test'
import { mockFetch } from '../testing/fetch'
import { act, renderApp, resetStoreAfterEach, screen, waitFor } from '../testing/render'
import { useCatalog } from '../stores/catalog'
import { voiceCatalog } from '../features/library/voiceFixtures'
import { VoicePicker } from './VoicePicker'

resetStoreAfterEach(useCatalog)
function setup(initial: VoiceRef = noVoice) {
  useCatalog.setState({ catalog: voiceCatalog })
  mockFetch((request) =>
    new URL(request.url).pathname === '/api/voices' ? Response.json([]) : undefined,
  )
  let update!: (value: VoiceRef) => void
  const changed = vi.fn()
  function Harness() {
    const [value, setValue] = useState(initial)
    useLayoutEffect(() => {
      update = setValue
    }, [])
    return (
      <VoicePicker
        value={value}
        onChange={(value) => {
          changed(value)
          setValue(value)
        }}
      />
    )
  }
  return {
    ...renderApp(<Harness />),
    changed,
    update: (value: VoiceRef) => act(() => update(value)),
  }
}

it.each(['mock-female', 'initial-custom'])(
  '外部音色从 %s 切换后同步编辑字段，默认选择和撤销值保持一致',
  async (voiceId) => {
    const view = setup({ provider: 'plein/mock', voiceId })
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    view.update({ provider: 'plein/mock', voiceId: 'external-custom' })
    expect((screen.getByRole('textbox', { name: '音色 ID' }) as HTMLInputElement).value).toBe(
      'external-custom',
    )
    view.update({ provider: 'plein/mock', voiceId: 'mock-female' })
    expect(screen.queryByRole('textbox', { name: '音色 ID' })).toBeNull()
    expect(screen.getByRole('combobox').textContent).toContain('Mock 女声')
    view.update({ provider: 'plein/mock', voiceId: 'restored-custom' })
    await view.user.click(screen.getByRole('combobox'))
    await view.user.click(screen.getByRole('option', { name: '平台默认音色' }))
    expect(view.changed).toHaveBeenLastCalledWith(noVoice)
    expect(screen.queryByRole('textbox', { name: '音色 ID' })).toBeNull()
    view.update({ provider: 'plein/mock', voiceId: 'restored-custom' })
    expect((screen.getByRole('textbox', { name: '音色 ID' }) as HTMLInputElement).value).toBe(
      'restored-custom',
    )
  },
)

it('手填预置 ID 或清空字段保持自定义入口，明确选预置才收起', async () => {
  const { user } = setup()
  await user.click(screen.getByRole('combobox'))
  await user.click(screen.getByRole('option', { name: '自定义音色 ID…' }))
  const provider = screen.getByRole('textbox', { name: '音色所属平台' })
  const voice = screen.getByRole('textbox', { name: '音色 ID' })
  await user.type(provider, 'plein/mock')
  await user.type(voice, 'mock-female')
  expect(screen.getByRole('combobox').textContent).toBe('自定义音色 ID…')
  await user.clear(voice)
  await user.clear(provider)
  expect(screen.getByRole('textbox', { name: '音色 ID' })).toBe(voice)
  await user.click(screen.getByRole('combobox'))
  await user.click(screen.getByRole('option', { name: /Mock 女声/ }))
  expect(screen.queryByRole('textbox', { name: '音色 ID' })).toBeNull()
})

it('音色读取失败不静默变成空列表，重试保留当前选择', async () => {
  useCatalog.setState({ catalog: voiceCatalog })
  let failed = true
  mockFetch((request) =>
    new URL(request.url).pathname === '/api/voices'
      ? failed
        ? Response.json({ error: '暂时离线' }, { status: 503 })
        : Response.json([])
      : undefined,
  )
  const changed = vi.fn()
  const { user } = renderApp(
    <VoicePicker value={{ provider: 'plein/mock', voiceId: 'mock-female' }} onChange={changed} />,
  )
  expect((await screen.findByRole('alert')).textContent).toContain('当前选择已保留')
  failed = false
  await user.click(screen.getByRole('button', { name: '重试' }))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(screen.getByRole('combobox').textContent).toContain('Mock 女声')
  expect(changed).not.toHaveBeenCalled()
})
