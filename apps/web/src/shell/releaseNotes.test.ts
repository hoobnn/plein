import { describe, expect, it } from 'vite-plus/test'
import { renderReleaseNotes } from './releaseNotes'

describe('release notes', () => {
  it('renders Markdown headings, lists, code and safe external links', () => {
    const html = renderReleaseNotes(
      '## 更新内容\n\n- 优化下载进度\n- 修复更新检测\n\n`checkForUpdates()`\n\n[完整记录](https://example.test/releases)',
    )
    expect(html).toContain('<h2>更新内容</h2>')
    expect(html).toContain('<li>优化下载进度</li>')
    expect(html).toContain('<code>checkForUpdates()</code>')
    expect(html).toContain('href="https://example.test/releases"')
    expect(html).toContain('target="_blank" rel="noopener noreferrer"')
  })

  it('keeps inline HTML and fenced HTML in Markdown literal', () => {
    const html = renderReleaseNotes(
      '新增 <strong onclick="alert(1)">交互</strong>\n\n```html\n<script>alert(1)</script>\n```',
    )
    expect(html).not.toContain('<strong')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;strong')
    expect(html).toContain('&lt;script&gt;')
  })

  it('rejects script links in Markdown', () => {
    const html = renderReleaseNotes('[不可执行](javascript:alert(1))')
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('<script')
  })

  it('safely escapes HTML when a DOM is unavailable', () => {
    expect(typeof document).toBe('undefined')
    const html = renderReleaseNotes('<h2>更新内容</h2><script>alert(1)</script>')
    expect(html).not.toContain('<h2>')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;h2&gt;更新内容&lt;/h2&gt;')
  })
})
