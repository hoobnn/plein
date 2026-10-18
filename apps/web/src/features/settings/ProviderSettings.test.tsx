import type { Catalog } from '@plein/protocol'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vite-plus/test'
import { ProviderSettings } from './ProviderSettings'

const catalog = (): Catalog => ({
  plugins: [],
  nodes: [],
  templates: [],
  prompts: [],
  elements: [],
  defaultModels: { 'text.chat': 'test/platform:chat' },
  providers: [
    {
      id: 'test/platform',
      plugin: 'test/plugin',
      title: '测试平台',
      enabled: true,
      configured: true,
      settingsSchema: {},
      secrets: [],
      models: [{ id: 'chat', title: '测试对话', capabilities: ['text.chat'] }],
    },
  ],
})
function render(data: Catalog | null, error: string | null = null) {
  return renderToStaticMarkup(
    <ProviderSettings
      catalog={data}
      catalogError={error}
      load={async () => {}}
      openProvider={null}
      onToggleOpen={() => {}}
    />,
  )
}
function control(html: string, name: string) {
  return (
    (html.match(/<button\b[^>]*>/g) ?? []).find((button) =>
      button.includes(`aria-label="${name}"`),
    ) ?? ''
  )
}

it('尚未读取的平台目录显示加载状态，不误报没有插件', () => {
  const html = render(null)
  expect(html).toContain('role="status"')
  expect(html).toContain('读取模型平台')
  expect(html).not.toContain('还没有安装模型平台插件')
  expect(html).not.toContain('重试更新平台目录')
})

it('首次读取失败显示原因与重试，不冒充空目录或已有缓存', () => {
  const html = render(null, '读取暂不可用')
  expect(html).toContain('role="alert"')
  expect(html).toContain('读取暂不可用')
  expect(html).toContain('重试更新平台目录')
  expect(html).not.toContain('还没有安装模型平台插件')
  expect(html).not.toContain('当前显示上次读取的目录')
})

it('刷新失败保留已读目录，说明缓存状态并阻断旧配置写入', () => {
  const html = render(catalog(), '刷新暂不可用')
  expect(html).toContain('data-provider="test/platform"')
  expect(html).toContain('当前显示上次读取的目录；已完成的保存无需重复。')
  expect(html).toContain('刷新暂不可用')
  expect(html).toContain('重试更新平台目录')
  expect(control(html, '默认文本模型')).toContain('disabled=""')
  expect(control(html, '启用 测试平台')).toContain('disabled=""')
})

it('正常目录保留可操作的模型与平台开关，不显示恢复入口', () => {
  const html = render(catalog())
  expect(html).toContain('测试对话')
  expect(control(html, '默认文本模型')).toContain('role="combobox"')
  expect(control(html, '默认文本模型')).not.toContain('disabled=""')
  expect(control(html, '启用 测试平台')).toContain('role="switch"')
  expect(control(html, '启用 测试平台')).not.toContain('disabled=""')
  expect(html).not.toContain('role="alert"')
  expect(html).not.toContain('重试更新平台目录')
})

it('只有成功读取的空目录才显示没有平台的结论', () => {
  const data = catalog()
  data.providers = []
  data.defaultModels = {}
  const html = render(data)
  expect(html).toContain('还没有安装模型平台插件')
  expect(html).not.toContain('读取模型平台')
  expect(html).not.toContain('role="alert"')
})
