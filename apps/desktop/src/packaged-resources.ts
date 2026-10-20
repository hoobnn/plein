import { accessSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerPaths } from './paths'

/** 打包资源必须完整；由启动流程调用，错误进入既有 fatal 对话框。 */
export function packagedServerPaths(resources: string, platform: string): ServerPaths {
  const executable = (name: string) =>
    join(resources, 'ffmpeg', platform === 'win32' ? `${name}.exe` : name)
  const paths = {
    entry: join(resources, 'server', 'main.mjs'),
    cwd: join(resources, 'server'),
    webDist: join(resources, 'web'),
    ffmpeg: executable('ffmpeg'),
    ffprobe: executable('ffprobe'),
    subtitleFont: join(resources, 'fonts', 'NotoSansCJKsc-Regular.otf'),
  }
  for (const [file, executable] of [
    [paths.entry, false],
    [join(paths.webDist, 'index.html'), false],
    [paths.ffmpeg, true],
    [paths.ffprobe, true],
    [paths.subtitleFont, false],
  ] as const) {
    try {
      if (!statSync(file).isFile()) throw new Error('不是文件')
      accessSync(file, executable && platform !== 'win32' ? constants.X_OK : constants.R_OK)
    } catch {
      throw new Error(`安装包资源缺失或不可访问：${file}。请重新安装完整应用。`)
    }
  }
  return paths
}
