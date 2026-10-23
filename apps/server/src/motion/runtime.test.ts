import { describe, expect, it } from 'vite-plus/test'
import { motionRuntimeAssets } from './runtime'

describe('motion packaged font contract', () => {
  it('preserves Chinese unicode subsets and both weights while referencing only staged WOFF2', async () => {
    const assets = await motionRuntimeAssets()
    expect(assets.fontCss).toContain('unicode-range:')
    expect(assets.fontCss).toContain('font-weight: 400')
    expect(assets.fontCss).toContain('font-weight: 700')
    const fonts = assets.files.filter((file) => file.path.startsWith('fonts/'))
    expect(fonts.length).toBeGreaterThan(100)
    expect(fonts.every((file) => file.path.endsWith('.woff2'))).toBe(true)
    expect(assets.fontCss).not.toMatch(/\.woff[)'"\s]/)
    expect(assets.fontCss).not.toMatch(/https?:|@import|data:/)
    const referenced = [...assets.fontCss.matchAll(/url\("\.\/([^"\s]+)"\)/g)].map(
      (match) => `fonts/${match[1]}`,
    )
    expect(new Set(referenced)).toEqual(new Set(fonts.map((file) => file.path)))
  })
})
