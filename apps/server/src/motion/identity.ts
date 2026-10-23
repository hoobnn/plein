import { MOTION_TEMPLATE_VERSION } from '@plein/nodes'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HYPERFRAMES_VERSION } from './runtime'

/** 只发现宿主浏览器，不向worker继承用户HOME或凭据。显式路径优先。 */
export function motionChromePath(): string | undefined {
  const configured = process.env.PLEIN_HYPERFRAMES_CHROME_PATH
  if (configured) return configured
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ]
  const cache = join(homedir(), '.cache/puppeteer')
  for (const family of ['chrome', 'chrome-headless-shell']) {
    const dir = join(cache, family)
    if (!existsSync(dir)) continue
    for (const build of readdirSync(dir).sort().reverse()) {
      const base = join(dir, build)
      for (const suffix of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-linux64/chrome',
        'chrome-headless-shell-mac-arm64/chrome-headless-shell',
        'chrome-headless-shell-linux64/chrome-headless-shell',
      ])
        candidates.push(join(base, suffix))
    }
  }
  return candidates.find((file) => existsSync(file))
}

export function motionRendererIdentity(
  tools: { ffmpeg: string; ffprobe: string },
  chrome?: string,
): string {
  const file = (path: string | undefined) => {
    if (!path) return null
    try {
      const info = statSync(path)
      return { size: info.size, mtime: info.mtimeMs, path }
    } catch {
      return { path, missing: true }
    }
  }
  return createHash('sha256')
    .update(
      JSON.stringify({
        adapter: 1,
        templateVersion: MOTION_TEMPLATE_VERSION,
        hyperframes: HYPERFRAMES_VERSION,
        gsap: '3.14.2',
        font: 'noto-sans-sc@5.2.8:400,700',
        ffmpeg: file(tools.ffmpeg),
        ffprobe: file(tools.ffprobe),
        chrome: file(chrome),
      }),
    )
    .digest('hex')
}
