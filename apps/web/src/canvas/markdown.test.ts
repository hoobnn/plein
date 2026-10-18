import { describe, expect, it } from 'vite-plus/test'
import { renderMarkdown } from './markdown'

describe('canvas Markdown content', () => {
  it('opens explicit and automatically detected links without an opener', () => {
    for (const text of [
      '[参考资料](https://reference.test/guide)',
      'https://reference.test/guide',
    ]) {
      const html = renderMarkdown(text)
      expect(html).toContain('href="https://reference.test/guide"')
      expect(html).toContain('target="_blank"')
      expect(html).toContain('rel="noopener noreferrer"')
    }
  })

  it('displays pasted HTML as literal text and rejects script links', () => {
    const html = renderMarkdown(
      '<img src=x onerror=alert(1)>\n<script>alert(1)</script>\n[脚本](javascript:alert(1))',
    )
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('&lt;img')
    expect(html).toContain('&lt;script&gt;')
  })

  it('preserves Chinese line breaks, tables and literal code', () => {
    const html = renderMarkdown(
      '第一行\n第二行\n\n| 镜头 | 内容 |\n| --- | --- |\n| 01 | 水杯 |\n\n```html\n<button>按钮</button>\n```',
    )
    expect(html).toContain('第一行<br>\n第二行')
    expect(html).toContain('<th>镜头</th>')
    expect(html).toContain('<td>水杯</td>')
    expect(html).toContain('&lt;button&gt;按钮&lt;/button&gt;')
    expect(html).not.toContain('<button>')
  })

  it('keeps image references and escapes quoted alternative text', () => {
    const html = renderMarkdown('![参考"图片](/figure.png)')
    expect(html).toContain('src="/figure.png"')
    expect(html).toContain('alt="参考&quot;图片"')
  })
})
