import { spawnSync } from 'node:child_process'
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repair = 'pnpm --filter @plein/desktop runtime:install'

/** 只检查当前依赖指向的运行时，不导入会自动下载二进制的 electron/index.js。 */
export function checkRuntime(
  packageDir: string,
  override = process.env.ELECTRON_OVERRIDE_DIST_PATH,
) {
  const { version } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    version: string
  }
  try {
    let relative: string
    try {
      relative = readFileSync(join(packageDir, 'path.txt'), 'utf8')
    } catch {
      if (!override) throw new Error('缺少 path.txt，二进制尚未安装')
      // 与 Electron 自己的入口保持一致；显式 override 不使用其他版本的缓存目录。
      relative = 'electron'
    }
    if (!relative) throw new Error('path.txt 为空')
    const executable = join(override || join(packageDir, 'dist'), relative)
    if (!statSync(executable).isFile()) throw new Error('运行时路径不是可执行文件')
    accessSync(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    if (!override) {
      const actual = readFileSync(join(packageDir, 'dist', 'version'), 'utf8')
        .trim()
        .replace(/^v/, '')
      if (actual !== version) throw new Error(`二进制版本 ${actual || '为空'}，与依赖版本不一致`)
    }
    return { version, executable }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Electron ${version} 本地运行时不可用：${detail}\n依赖目录：${packageDir}\n运行 ${repair} 安装当前依赖版本；下载需要可用网络。`,
    )
  }
}

/** 显式安装仍交给当前 Electron 包的官方安装器，保留其缓存、镜像与校验逻辑。 */
export function installRuntime(packageDir: string) {
  const result = spawnSync(process.execPath, [join(packageDir, 'install.js')], {
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(
      `Electron 安装未完成（${result.signal ?? result.status}），请检查上方下载错误后重试 ${repair}。`,
    )
  return checkRuntime(packageDir)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--install'))
      throw new Error('用法：node scripts/runtime.ts [--install]')
    const packageDir = dirname(createRequire(import.meta.url).resolve('electron/package.json'))
    if (process.argv.includes('--install'))
      console.log(`正在安装当前依赖目录的 Electron：${packageDir}`)
    const runtime = process.argv.includes('--install')
      ? installRuntime(packageDir)
      : checkRuntime(packageDir)
    console.log(
      process.env.ELECTRON_OVERRIDE_DIST_PATH
        ? `Electron 自定义运行时已就绪（依赖版本 ${runtime.version}，自定义二进制版本未核验）：${runtime.executable}`
        : `Electron ${runtime.version} 本地运行时已就绪：${runtime.executable}`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
