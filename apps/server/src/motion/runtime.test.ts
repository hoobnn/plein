import { describe, expect, it } from 'vite-plus/test'
import { createRequire } from 'node:module'
import { GSAP_VERSION, FONT_VERSION, HYPERFRAMES_VERSION, motionRuntimeAssets } from './runtime'

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

// Cache identities and archived source locks must describe the versions actually shipped.
it('keeps renderer versions aligned with server and web dependency pins', () => {
  const require = createRequire(import.meta.url)
  const server = require('../../package.json') as { dependencies: Record<string, string> }
  const web = require('../../../web/package.json') as { dependencies: Record<string, string> }
  for (const name of ['@hyperframes/producer', '@hyperframes/sdk', '@hyperframes/player']) {
    expect(server.dependencies[name]).toBe(HYPERFRAMES_VERSION)
  }
  for (const name of ['@hyperframes/sdk', '@hyperframes/player']) {
    expect(web.dependencies[name]).toBe(HYPERFRAMES_VERSION)
  }
  expect(server.dependencies.gsap).toBe(GSAP_VERSION)
  expect(server.dependencies['@fontsource/noto-sans-sc']).toBe(FONT_VERSION)
})
