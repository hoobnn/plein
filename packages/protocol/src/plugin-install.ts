import type { PluginManifest } from '@plein/plugin-sdk'
import { z } from 'zod'

export const PLUGIN_INSTALL_MAX_UPLOAD = 20 * 1024 * 1024
export const PluginInstallToken = z.object({ token: z.string().uuid() })

/** 预检不执行插件代码；贡献内容是否与声明相符，仍在用户启用时由宿主检查。 */
export interface PluginInstallPreview {
  token: string
  expiresAt: number
  sha256: string
  files: number
  bytes: number
  manifest: PluginManifest
}
