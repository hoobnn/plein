import { arkPlugin, bailianPlugin, doubaoPlugin, minimaxPlugin, mockPlugin } from '@plein/providers'
import type { ServerPluginDefinition } from '@plein/plugin-sdk'
import { coreServerPlugin } from '../executors/core'

/** 内置插件：与主进程同进程加载，走和第三方插件同一套注册表 */
export function builtinPlugins(opts: { mock: boolean }): ServerPluginDefinition[] {
  return [
    coreServerPlugin,
    ...(opts.mock ? [mockPlugin] : []),
    minimaxPlugin,
    doubaoPlugin,
    bailianPlugin,
    arkPlugin,
  ]
}
