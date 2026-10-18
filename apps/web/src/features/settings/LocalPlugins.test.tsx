import type { LocalPluginInfo } from '@plein/protocol'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vite-plus/test'
import { queryKeys } from '../../api/query'
import { LocalPlugins } from './LocalPlugins'

function render(data?: LocalPluginInfo[], error?: Error) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } },
  })
  const query = client.getQueryCache().build(client, { queryKey: queryKeys.localPlugins })
  if (data) query.setState({ data, status: 'success' })
  if (error) query.setState({ error, status: 'error' })
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <LocalPlugins />
    </QueryClientProvider>,
  )
  client.clear()
  return html
}

describe('插件读取状态', () => {
  it('读取中不冒充空列表', () => {
    const html = render()
    expect(html).toContain('role="status"')
    expect(html).toContain('正在读取本机插件')
    expect(html).not.toContain('还没有本机插件')
  })
  it('首次读取失败显示原因与重试入口，不显示空列表结论', () => {
    const html = render(undefined, new Error('列表暂不可用'))
    expect(html).toContain('role="alert"')
    expect(html).toContain('列表暂不可用')
    expect(html).toContain('重试读取插件')
    expect(html).not.toContain('还没有本机插件')
  })
  it('刷新失败保留最后的已加载状态，同时提供读取失败提示', () => {
    const html = render(
      [
        {
          id: 'acme/echo',
          name: '已加载示例',
          version: '1',
          dir: '/tmp/plugin',
          enabled: true,
          status: 'active',
        },
      ],
      new Error('刷新失败'),
    )
    expect(html).toContain('data-plugin="acme/echo"')
    expect(html).toContain('已加载示例')
    expect(html).toContain('重新加载')
    expect(html).toContain('刷新失败')
    expect(html).toContain('重试读取插件')
  })
  it('成功读取空数组后才能显示空列表提示', () => {
    const html = render([])
    expect(html).toContain('还没有本机插件')
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('正在读取本机插件')
  })
})
