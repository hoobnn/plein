import type { ServerPaths } from './paths'

export const DEV_SERVER_PORT = 8787

/** 保留开发覆盖；安装包只使用其已解析的资源，不继承另一构建的路径或开发模式。 */
export function serverEnvironment(
  paths: ServerPaths,
  options: {
    packaged: boolean
    development: boolean
    port: number
    dataDir: string
    token: string
    inherited: NodeJS.ProcessEnv
  },
): Record<string, string> {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(options.inherited).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
  const development = !options.packaged && options.development
  Object.assign(env, {
    PLEIN_HOST: '127.0.0.1',
    PLEIN_PORT: String(development ? DEV_SERVER_PORT : options.port),
    PLEIN_AUTH: 'none',
    PLEIN_DATA_DIR: options.dataDir,
    PLEIN_DESKTOP_TOKEN: options.token,
  })
  if (options.packaged) {
    delete env.PLEIN_DESKTOP_DEV
    delete env.PLEIN_DESKTOP_WEB_URL
  }
  const resources = {
    PLEIN_WEB_DIST: paths.webDist,
    PLEIN_FFMPEG_PATH: paths.ffmpeg,
    PLEIN_FFPROBE_PATH: paths.ffprobe,
    PLEIN_SUBTITLE_FONT: paths.subtitleFont,
  }
  for (const [key, value] of Object.entries(resources)) {
    if (options.packaged) {
      if (!value) throw new Error(`安装包未声明资源路径：${key}`)
      env[key] = value
    } else if (value) {
      if (key === 'PLEIN_SUBTITLE_FONT') env[key] ??= value
      else env[key] = value
    }
  }
  if (development) env.PLEIN_MOCK_PROVIDER ??= '1'
  return env
}
