import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'

/** 构建产物在 apps/desktop/dist/，仓库根目录在上三级 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

/** 开发模式：`electron . --dev`，服务端跑源码，页面来自 Vite */
export const isDev = process.argv.includes('--dev') || process.env.PLEIN_DESKTOP_DEV === '1'

/**
 * 图标与网页资产一同交付，开发与安装包使用同一份。
 * macOS 不会给 Dock / 关于面板的图标套圆角，所以用按 Apple 网格预先裁好的版本（824 主体 + 透明边 + 投影）。
 */
export function appIconPath() {
  const file = process.platform === 'darwin' ? 'plein-icon-mac.png' : 'plein-icon.png'
  return app.isPackaged
    ? join(process.resourcesPath, 'web', file)
    : join(repoRoot, 'apps/web/public', file)
}

export interface ServerPaths {
  /** 服务端入口脚本 */
  entry: string
  cwd: string
  /** 前端构建产物；开发模式下由 Vite 提供，不需要 */
  webDist?: string
  /** 随安装包附带的 ffmpeg / ffprobe，不存在时服务端从 PATH 查找 */
  ffmpeg?: string
  ffprobe?: string
  /** 随安装包附带的字幕字体，导出和预览共用 */
  subtitleFont?: string
}

const SUBTITLE_FONT = 'NotoSansCJKsc-Regular.otf'
const existing = (file: string) => (existsSync(file) ? file : undefined)

function bundled(dir: string, name: string) {
  const file = join(dir, process.platform === 'win32' ? `${name}.exe` : name)
  return existsSync(file) ? file : undefined
}

export function serverPaths(): ServerPaths {
  if (app.isPackaged) {
    // 安装包布局在打包阶段（M4）确定：resources/server、resources/web、resources/ffmpeg
    const res = process.resourcesPath
    return {
      entry: join(res, 'server', 'main.mjs'),
      cwd: join(res, 'server'),
      webDist: join(res, 'web'),
      ffmpeg: bundled(join(res, 'ffmpeg'), 'ffmpeg'),
      ffprobe: bundled(join(res, 'ffmpeg'), 'ffprobe'),
      subtitleFont: existing(join(res, 'fonts', SUBTITLE_FONT)),
    }
  }
  const server = join(repoRoot, 'apps/server')
  if (isDev) {
    // 开发模式直接跑源码（经 tsx），改服务端代码后重启桌面端即可生效
    return {
      entry: join(repoRoot, 'apps/desktop/scripts/dev-server.mjs'),
      cwd: server,
      subtitleFont: existing(join(repoRoot, 'apps/desktop/stage/fonts', SUBTITLE_FONT)),
    }
  }
  return {
    entry: join(server, 'dist/main.mjs'),
    cwd: server,
    webDist: join(repoRoot, 'apps/web/dist'),
    subtitleFont: existing(join(repoRoot, 'apps/desktop/stage/fonts', SUBTITLE_FONT)),
  }
}

/** 开发模式下窗口加载 Vite 开发服务器，接口经 Vite 代理到固定端口的服务端 */
export const DEV_WEB_URL = process.env.PLEIN_DESKTOP_WEB_URL ?? 'http://localhost:5173'
export const DEV_SERVER_PORT = 8787

export function dataDir() {
  return process.env.PLEIN_DATA_DIR ?? join(app.getPath('userData'), 'data')
}
