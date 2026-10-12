import { z } from 'zod'
import { NamespacedId } from './ids'

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
/** 域名，允许一级通配：`ark.cn-beijing.volces.com`、`*.volces.com` */
const DOMAIN = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/

/**
 * 插件清单（`plein-plugin.json`）。
 * contributes 必须与插件实际注册的内容一致，权限按最小化声明，宿主据此裁剪运行环境。
 */
export const PluginManifest = z.object({
  id: NamespacedId,
  version: z.string().regex(SEMVER, '版本应为语义化版本，如 1.0.0'),
  name: z.string().min(1),
  description: z.string().optional(),
  author: z.string().optional(),
  homepage: z.url().optional(),
  engines: z.object({
    /** 兼容的插件 API 版本范围，如 `^0.1.0` */
    plein: z.string().min(1),
  }),
  /** 第三方插件的入口文件（相对插件目录）；内置插件不需要 */
  main: z
    .object({
      /** 前后端共用的声明（节点、模板、元素类型） */
      shared: z.string().optional(),
      /** 服务端代码（Provider、执行器），在独立子进程里运行 */
      server: z.string().optional(),
    })
    .optional(),
  contributes: z
    .object({
      /** `vendor/name@版本` */
      nodes: z.array(z.string()).default([]),
      providers: z.array(NamespacedId).default([]),
      templates: z.array(NamespacedId).default([]),
      elements: z.array(NamespacedId).default([]),
      /** 提示词预设 */
      prompts: z.array(NamespacedId).default([]),
    })
    .default({ nodes: [], providers: [], templates: [], elements: [], prompts: [] }),
  permissions: z
    .object({
      /** 可访问的域名 */
      network: z.array(z.string().regex(DOMAIN, '域名格式不正确')).default([]),
      /** 可读取的密钥名（大写下划线） */
      secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/, '密钥名应为大写下划线')).default([]),
      /** 资产库访问 */
      assets: z.enum(['none', 'read', 'write']).default('none'),
      /** 用宿主的 ffmpeg 读取媒体信息、合成视频（结果写入资产库） */
      media: z.boolean().default(false),
    })
    .default({ network: [], secrets: [], assets: 'none', media: false }),
})
export type PluginManifest = z.output<typeof PluginManifest>
export type PluginManifestInput = z.input<typeof PluginManifest>

/** 域名是否被清单允许 */
export function domainAllowed(allowed: readonly string[], hostname: string) {
  const host = hostname.toLowerCase()
  return allowed.some((d) =>
    d.startsWith('*.') ? host.endsWith(d.slice(1)) && host.length > d.length - 1 : host === d,
  )
}
