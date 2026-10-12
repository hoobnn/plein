import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type AuthMode = 'none' | 'password'

export interface Config {
  host: string
  port: number
  /** 数据目录：SQLite、资产、导出、日志、密钥 */
  dataDir: string
  /** none：直接放行（只适合本机）；password：要求登录 */
  auth: AuthMode
  /** 对外访问地址（反向代理后），用于生成回调链接；不填按请求推断 */
  publicUrl?: string
  /** 前端构建产物目录，存在时由服务端一并提供 */
  webDist: string | null
  /** 单个上传文件上限（字节） */
  maxUpload: number
  /** 免认证模式下额外允许的主机名（默认只允许本机名） */
  allowedHosts: string[]
  /** 加载开发测试用的 mock 平台 */
  mockProvider: boolean
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

/** 源码和打包产物都在 apps/server/<src|dist>/ 下，仓库根目录在上三级 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.PLEIN_HOST ?? '127.0.0.1'
  const auth = (env.PLEIN_AUTH ?? (LOOPBACK.has(host) ? 'none' : 'password')) as AuthMode
  if (auth !== 'none' && auth !== 'password') {
    throw new Error(`PLEIN_AUTH 只能是 none 或 password，收到 ${auth}`)
  }
  const webDist = resolve(env.PLEIN_WEB_DIST ?? resolve(repoRoot, 'apps/web/dist'))
  return {
    host,
    port: Number(env.PLEIN_PORT ?? 8787),
    dataDir: resolve(env.PLEIN_DATA_DIR ?? resolve(repoRoot, 'data')),
    auth,
    publicUrl: env.PLEIN_PUBLIC_URL || undefined,
    webDist: existsSync(resolve(webDist, 'index.html')) ? webDist : null,
    maxUpload: Number(env.PLEIN_MAX_UPLOAD_MB ?? 2048) * 1024 * 1024,
    allowedHosts: (env.PLEIN_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    mockProvider: env.PLEIN_MOCK_PROVIDER === '1',
  }
}
