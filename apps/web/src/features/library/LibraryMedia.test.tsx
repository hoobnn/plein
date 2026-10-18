import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vite-plus/test'
import { LibraryThumbnail, ReferenceVideo } from './LibraryMedia'

describe('资产预览的可访问入口', () => {
  it('图片候选有素材名称，已用和外层忙碌时不能再次选择', () => {
    for (const state of [{ selected: true }, { disabled: true }]) {
      const markup = renderToStaticMarkup(
        <LibraryThumbnail
          src="/reference.png"
          label="选择图片「水杯」"
          title="水杯.png"
          onSelect={() => {}}
          {...state}
        />,
      )
      expect(markup).toContain('aria-label="选择图片「水杯」"')
      expect(markup).toContain('title="水杯.png"')
      expect(markup).toContain('disabled=""')
    }
    const preview = renderToStaticMarkup(
      <LibraryThumbnail src="/reference.png" label="参考 &lt;水杯&gt;" contain />,
    )
    expect(preview).toContain('alt="参考 &lt;水杯&gt;"')
    expect(preview).not.toContain('<button')
    expect(preview).toContain('object-contain')
  })
  it('视频保留原生播放控件与按需加载，不自动播放', () => {
    const markup = renderToStaticMarkup(<ReferenceVideo src="/reference.mp4" />)
    expect(markup).toContain('controls=""')
    expect(markup).toContain('preload="metadata"')
    expect(markup).not.toContain('autoPlay')
  })
})
