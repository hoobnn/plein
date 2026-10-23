import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { MotionError } from './process'

export const HYPERFRAMES_VERSION = '0.8.186'
export interface MotionRuntimeAssets {
  gsapPath: string
  /** CSS contains all Chinese unicode-range subsets, with project-relative font URLs. */
  fontCss: string
  files: { path: string; sourcePath: string }[]
}

/** Resolve only bundled, redistributable package assets; never use a CDN or system fonts. */
export async function motionRuntimeAssets(): Promise<MotionRuntimeAssets> {
  const require = createRequire(import.meta.url)
  try {
    const gsapPath = require.resolve('gsap/dist/gsap.min.js')
    const cssPath = require.resolve('@fontsource/noto-sans-sc/400.css')
    const root = dirname(cssPath)
    const files = new Map<string, string>()
    let fontCss = ''
    for (const weight of [400, 700]) {
      const sourceCss = await readFile(join(root, `${weight}.css`), 'utf8')
      if (/https?:|data:|@import/i.test(sourceCss))
        throw new Error('Font CSS contains external resources')
      // Desktop Chromium supports WOFF2; stage intentionally omits duplicate WOFF fallbacks.
      const css = sourceCss.replace(/src:\s*([^;]+);/g, (_match, sources: string) => {
        const woff2 = [
          ...sources.matchAll(
            /url\((['"]?)(\.\/files\/[^)'"\s]+\.woff2)\1\)\s*format\((['"])woff2\3\)/g,
          ),
        ]
        if (woff2.length !== 1) throw new Error('Expected one local WOFF2 source per font face')
        return `src: ${woff2[0]![0]};`
      })
      const rewritten = css.replace(
        /url\((['"]?)(\.\/files\/[^)'"\s]+)\1\)/g,
        (_match, _quote: string, relative: string) => {
          const sourcePath = resolve(root, relative)
          if (!sourcePath.startsWith(root + sep)) throw new Error('Font path escapes package')
          const path = `fonts/${relative.slice(2)}`
          files.set(path, sourcePath)
          return `url("./${relative.slice(2)}")`
        },
      )
      if (/https?:|data:|@import/i.test(rewritten))
        throw new Error('Font CSS contains external resources')
      fontCss += rewritten + '\n'
    }
    files.set('licenses/noto-sans-sc.txt', join(root, 'LICENSE'))
    const gsapRoot = dirname(require.resolve('gsap/package.json'))
    files.set('licenses/gsap-notice.md', join(gsapRoot, 'README.md'))
    files.set('licenses/gsap-package.json', join(gsapRoot, 'package.json'))
    return {
      gsapPath,
      fontCss,
      files: [...files].map(([path, sourcePath]) => ({ path, sourcePath })),
    }
  } catch (error) {
    throw new MotionError(
      'motion_runtime_unavailable',
      `Offline GSAP / Noto Sans SC assets unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
