import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vite-plus/test'
import { LibraryReadStatus } from './LibraryReadStatus'

const render = (props: { loaded?: boolean; loading?: boolean; error?: string }) =>
  renderToStaticMarkup(
    <LibraryReadStatus
      loaded={props.loaded ?? false}
      loading={props.loading ?? false}
      error={props.error ?? null}
      load={async () => {}}
    />,
  )

describe('资产库读取状态展示', () => {
  it('首次读取与缓存刷新给出不同的可访问反馈', () => {
    const first = render({ loading: true })
    expect(first).toContain('role="status"')
    expect(first).toContain('正在读取资产库')
    expect(first).not.toContain('重新读取')
    expect(render({ loaded: true, loading: true })).toContain('正在刷新资产库')
  })
  it('首次失败显示错误与恢复入口，不声称存在历史结果', () => {
    const failed = render({ error: '读取<失败>' })
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('读取&lt;失败&gt;')
    expect(failed).toContain('重新读取')
    expect(failed).not.toContain('上次读取')
  })
  it('刷新失败明确说明缓存未更新，恢复后撤下错误状态', () => {
    expect(render({ loaded: true, error: '离线' })).toContain('保留上次读取的结果')
    expect(render({ loaded: true })).toBe('')
  })
})
