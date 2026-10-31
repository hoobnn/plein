// @vitest-environment happy-dom
import type { ProviderConfigView, ProviderInfo } from '@plein/protocol'
import { useEffect, useState } from 'react'
import { describe, expect, it } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { fireEvent, renderApp, screen, waitFor } from '../../testing/render'
import { ProviderRow } from './ProviderSettings'

const provider: ProviderInfo = {
  id: 'plein/mock',
  plugin: 'plein/mock',
  title: 'Mock（开发测试用）',
  description: '不联网的假平台',
  enabled: true,
  // 这个用例只关心数字编辑与校验按钮的启用状态：用已配置平台才有底部校验按钮
  configured: true,
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
    },
  },
  secrets: [],
  models: [{ id: 'chat', title: 'Mock 对话', capabilities: ['text.chat'] }],
}

const view = (settings: Record<string, unknown>): ProviderConfigView => ({
  enabled: true,
  settings,
  secrets: {},
  credentials: [],
  activeCredential: null,
})

function renderRow() {
  const configPath = `/api/providers/${provider.id}/config`
  const fetch = mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    if (path === configPath)
      return Response.json(
        request.method === 'GET' ? view({ latencyMs: 300 }) : view({ latencyMs: 300 }),
      )
    if (path === `/api/providers/${provider.id}/test`)
      return Response.json({
        ok: true,
        scope: 'connection',
        modelAccess: 'unverified',
        checkedAt: 1,
      })
    return undefined
  })
  function Harness() {
    const [open, setOpen] = useState(true)
    useEffect(() => {
      // 平台设置收在「更多设置」里：出现后自动展开一次
      const observer = new MutationObserver(() => {
        const more = screen.queryByRole<HTMLButtonElement>('button', { name: '更多设置' })
        if (more && more.getAttribute('aria-expanded') === 'false') more.click()
      })
      observer.observe(document.body, { childList: true, subtree: true })
      return () => observer.disconnect()
    }, [])
    return (
      <ul>
        <ProviderRow
          provider={provider}
          open={open}
          onToggleOpen={() => setOpen(!open)}
          onSaved={() => {}}
        />
      </ul>
    )
  }
  renderApp(<Harness />)
  return fetch
}

const latency = () => screen.getByRole<HTMLInputElement>('spinbutton', { name: '模拟耗时（毫秒）' })
const testButton = () => screen.getByRole('button', { name: '校验连接' })
const unsaved = () => screen.queryByText(/修改尚未保存/)

describe('数字输入不合法时的平台面板', () => {
  it('草稿作废后不再停在未保存状态，检查按钮重新可用', async () => {
    renderRow()
    await waitFor(() => expect(latency().value).toBe('300'))

    // 输入不合法的内容：数字输入框里这是 badInput
    fireEvent.change(latency(), { target: { value: '1e' } })
    expect(unsaved()).not.toBeNull()
    expect((testButton() as HTMLButtonElement).disabled).toBe(true)

    // 失焦：草稿作废，值退回原样
    fireEvent.blur(latency())
    await waitFor(() => expect(screen.getByText('请输入有效数字，已保留原值')).toBeTruthy())
    expect(latency().value).toBe('300')
    // 没有未保存的改动，就不该再显示「修改尚未保存」，也不该把检查按钮永久禁用
    expect(unsaved()).toBeNull()
    expect((testButton() as HTMLButtonElement).disabled).toBe(false)
  })

  it('输入合法数字时仍然算未保存，按钮保持禁用', async () => {
    renderRow()
    await waitFor(() => expect(latency().value).toBe('300'))

    fireEvent.change(latency(), { target: { value: '500' } })
    expect(unsaved()).not.toBeNull()
    expect((testButton() as HTMLButtonElement).disabled).toBe(true)

    fireEvent.blur(latency())
    await waitFor(() => expect(latency().value).toBe('500'))
    expect(unsaved()).not.toBeNull()
    expect((testButton() as HTMLButtonElement).disabled).toBe(true)
  })
})
