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
  /** 同时运行的节点任务数上限 */
  maxJobs: number
  /** 加载开发测试用的 mock 平台 */
  mockProvider: boolean
  /** ffmpeg / ffprobe 可执行文件，默认从 PATH 查找；桌面端指向安装包里附带的版本 */
  ffmpegPath: string
  ffprobePath: string
  /**
   * 桌面端启动令牌：设置后所有请求都必须带上同值的 Cookie，
   * 只有桌面端自己的窗口能访问，本机其他程序和浏览器里的网页都会被拒绝
   */
  desktopToken?: string
  /**
   * 允许调用本机的 Claude Code / Codex CLI。只在免登录模式下开启：
   * 智能体以服务端进程的身份运行，开放给远程登录用户等于把本机交给对方
   */
  agent: boolean
}

/** 本机地址：监听在这些地址上默认免登录，免登录模式也只接受这些 Host */
export const LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** 源码和打包产物都在 apps/server/<src|dist>/ 下，仓库根目录在上三级 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.PLEIN_HOST ?? '127.0.0.1'
  const port = Number(env.PLEIN_PORT ?? 8787)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PLEIN_PORT 必须是 0–65535 的整数（0 表示随机端口），收到 ${env.PLEIN_PORT}`)
  }
  const auth = (env.PLEIN_AUTH ?? (LOOPBACK.has(host) ? 'none' : 'password')) as AuthMode
  if (auth !== 'none' && auth !== 'password') {
    throw new Error(`PLEIN_AUTH 只能是 none 或 password，收到 ${auth}`)
  }
  const webDist = resolve(env.PLEIN_WEB_DIST ?? resolve(repoRoot, 'apps/web/dist'))
  return {
    host,
    port,
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
    maxJobs: Math.max(1, Number(env.PLEIN_MAX_JOBS ?? 4) || 4),
    ffmpegPath: env.PLEIN_FFMPEG_PATH || 'ffmpeg',
    ffprobePath: env.PLEIN_FFPROBE_PATH || 'ffprobe',
    desktopToken: env.PLEIN_DESKTOP_TOKEN || undefined,
    agent: auth === 'none' && env.PLEIN_AGENT !== '0',
  }
}
