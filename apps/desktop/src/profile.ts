import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type DesktopProfile = 'production' | 'acceptance'

export function parseProfile(value: unknown): DesktopProfile {
  if (value === undefined || value === 'production') return 'production'
  if (value === 'acceptance') return 'acceptance'
  throw new Error('PLEIN_DESKTOP_PROFILE 只支持 production 或 acceptance')
}

/** 包内身份被冻结在 package.json；启动环境变量不能把正式包变成验收包，反之亦然。 */
export function readProfile(packaged: boolean, appPath: string): DesktopProfile {
  if (packaged) {
    return parseProfile(
      JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')).pleinDesktopProfile,
    )
  }
  const profile = parseProfile(process.env.PLEIN_DESKTOP_PROFILE)
  if (profile === 'acceptance') {
    throw new Error(
      '验收身份必须通过独立打包的 Plein Acceptance 启动；开发 Electron 不具备独立 bundle ID',
    )
  }
  return profile
}

export function profileIdentity(profile: DesktopProfile) {
  return profile === 'acceptance'
    ? {
        appId: 'com.ikuyu.plein.acceptance',
        productName: 'Plein Acceptance',
        runtimeName: 'Plein Acceptance',
        windowTitle: 'Plein Acceptance · 验收环境',
        output: 'release-acceptance',
      }
    : {
        appId: 'com.ikuyu.plein',
        productName: 'Plein',
        runtimeName: 'plein',
        windowTitle: 'plein',
        output: 'release',
      }
}

interface ProfileApp {
  setName(name: string): void
  getPath(name: 'appData'): string
  setPath(name: 'userData', value: string): void
  setAppUserModelId(id: string): void
  requestSingleInstanceLock(): boolean
}

/** 验收运行目录由包内元数据冻结；生产包不接受命名空间。 */
export function parseAcceptanceNamespace(value: unknown): string | undefined {
  if (value === undefined) return
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value))
    throw new Error('验收命名空间只支持 1–64 位小写英文、数字和短横线')
  return value
}

export function readAcceptanceNamespace(
  packaged: boolean,
  appPath: string,
  profile: DesktopProfile,
) {
  if (!packaged || profile !== 'acceptance') return
  return parseAcceptanceNamespace(
    JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')).pleinAcceptanceNamespace,
  )
}

/** 必须在获取单实例锁、创建 session 或窗口前执行；正式版沿用既有 userData。 */
export function initializeProfile(app: ProfileApp, profile: DesktopProfile, namespace?: string) {
  const identity = profileIdentity(profile)
  app.setName(identity.runtimeName)
  if (profile === 'acceptance') {
    const selected = parseAcceptanceNamespace(namespace)
    const dir = selected
      ? join(app.getPath('appData'), identity.productName, selected)
      : join(app.getPath('appData'), identity.productName)
    mkdirSync(dir, { recursive: true })
    app.setPath('userData', dir)
  }
  if (process.platform === 'win32') app.setAppUserModelId(identity.appId)
  return app.requestSingleInstanceLock()
}

/** 验收包不读取继承的业务数据 override，避免误写正在制作的生产库。 */
export function profileDataDir(profile: DesktopProfile, userData: string, override?: string) {
  return profile === 'acceptance' ? join(userData, 'data') : (override ?? join(userData, 'data'))
}

export function canUpdate(
  profile: DesktopProfile,
  packaged: boolean,
  platform: string,
  setting?: string,
) {
  return profile === 'production' && packaged && platform === 'darwin' && setting !== '0'
}

/** 验收包保留原生标题栏，避免隐藏标题使测试实例难以辨认。 */
export function profileWindowChrome(profile: DesktopProfile, platform: string) {
  return platform === 'darwin' && profile === 'production'
    ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 20, y: 27 } }
    : { titleBarStyle: 'default' as const }
}

/** 安装包不能因终端继承的开发变量或命令行标记连接到开发页面。 */
export function desktopDevelopment(packaged: boolean, argv: string[], setting?: string) {
  return !packaged && (argv.includes('--dev') || setting === '1')
}
