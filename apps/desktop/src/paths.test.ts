import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const state = vi.hoisted(() => ({ packaged: false, files: new Set<string>() }))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.packaged
    },
  },
}))
vi.mock('node:fs', () => ({ existsSync: (file: string) => state.files.has(file) }))

const staged = (name: string) =>
  join(
    fileURLToPath(new URL('../../../', import.meta.url)),
    'apps/desktop/stage/ffmpeg',
    process.platform === 'win32' ? `${name}.exe` : name,
  )

beforeEach(() => {
  state.packaged = false
  state.files.clear()
  vi.stubEnv('PLEIN_FFMPEG_PATH', '')
  vi.stubEnv('PLEIN_FFPROBE_PATH', '')
  vi.stubEnv('PLEIN_DESKTOP_DEV', '1')
  vi.resetModules()
})
afterEach(() => vi.unstubAllEnvs())

describe('本地桌面媒体工具路径', () => {
  it.each(['1', '0'])('开发标记 %s 使用已构建的 stage 工具', async (dev) => {
    vi.stubEnv('PLEIN_DESKTOP_DEV', dev)
    const ffmpeg = staged('ffmpeg')
    const ffprobe = staged('ffprobe')
    state.files.add(ffmpeg)
    state.files.add(ffprobe)
    const { serverPaths } = await import('./paths')
    expect(serverPaths()).toMatchObject({ ffmpeg, ffprobe })
  })

  it('没有本地构建时不虚构工具路径，留给服务端按 PATH 查找', async () => {
    const { serverPaths } = await import('./paths')
    expect(serverPaths().ffmpeg).toBeUndefined()
    expect(serverPaths().ffprobe).toBeUndefined()
  })

  it('显式工具配置优先，即使路径不存在也不偷偷换成其他工具', async () => {
    state.files.add(staged('ffmpeg'))
    state.files.add(staged('ffprobe'))
    vi.stubEnv('PLEIN_FFMPEG_PATH', '/custom/ffmpeg')
    vi.stubEnv('PLEIN_FFPROBE_PATH', '/custom/ffprobe')
    const { serverPaths } = await import('./paths')
    expect(serverPaths()).toMatchObject({
      ffmpeg: '/custom/ffmpeg',
      ffprobe: '/custom/ffprobe',
    })
  })
})
