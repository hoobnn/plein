// macOS 安装包（electron-builder）。先运行 scripts/stage-server.mjs 和 scripts/build-ffmpeg.sh，
// 根目录的 pnpm dist:desktop 会按顺序做完。
//
// 签名与公证按环境变量决定：
// - CSC_LINK（.p12 证书，可以是 base64）+ CSC_KEY_PASSWORD：用 Developer ID 证书签名；
// - 再加 APPLE_ID、APPLE_APP_SPECIFIC_PASSWORD、APPLE_TEAM_ID：签名后提交 Apple 公证；
// - 都没有时做 ad-hoc 签名，本机能打开，发给别人会被 Gatekeeper 拦（右键“打开”可绕过）。
// CI 发版走 scripts/ci-build.sh：CSC_NAME 指向钥匙串里的证书，只签名不公证，公证由复用工作流做。
import { cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const signed = Boolean(process.env.CSC_LINK || process.env.CSC_NAME)
const notarize = signed && Boolean(process.env.APPLE_TEAM_ID && process.env.APPLE_ID)

if (!existsSync('stage/server/main.mjs')) throw new Error('先运行 node scripts/stage-server.mjs')
if (!existsSync('stage/ffmpeg/ffmpeg'))
  console.warn(
    '没有 stage/ffmpeg：安装包不附带 ffmpeg，运行时会从 PATH 查找（先运行 scripts/build-ffmpeg.sh）',
  )

/** @type {import('electron-builder').Configuration} */
export default {
  appId: 'app.plein.desktop',
  productName: 'Plein',
  copyright: 'Copyright © 2026 hoobnn',
  directories: { output: 'release', buildResources: 'resources' },
  // 发布时由 CI 按标签传入（v0.1.0 → 0.1.0）
  ...(process.env.PLEIN_VERSION ? { extraMetadata: { version: process.env.PLEIN_VERSION } } : {}),
  files: ['dist/**/*', 'package.json'],
  // 与 apps/desktop/src/paths.ts 里 app.isPackaged 时的布局一致
  extraResources: [
    // extraResources 总会跳过 node_modules，原生模块在 afterPack 里补上
    { from: 'stage/server', to: 'server' },
    { from: '../web/dist', to: 'web' },
    ...(existsSync('stage/ffmpeg/ffmpeg') ? [{ from: 'stage/ffmpeg', to: 'ffmpeg' }] : []),
  ],
  // 原生模块已在 stage/server 里按当前平台准备好，Electron 侧没有原生依赖
  npmRebuild: false,
  // 界面只有中文，Electron 自带的其他语言包不带
  electronLanguages: ['zh_CN', 'zh_TW', 'en'],
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.video',
    icon: '../web/public/plein-icon-mac.png',
    minimumSystemVersion: '12.0',
    hardenedRuntime: true,
    entitlements: 'resources/entitlements.mac.plist',
    entitlementsInherit: 'resources/entitlements.mac.plist',
    // null 不签名，"-" 是 ad-hoc 签名（Apple 芯片上未签名的程序无法运行）
    identity: signed ? undefined : '-',
    notarize,
    artifactName: 'Plein-${version}-${arch}-mac.${ext}',
  },
  dmg: {
    title: 'Plein ${version}',
    artifactName: 'Plein-${version}-${arch}.dmg',
  },
  publish: null,
  /** 签名之前把服务端的原生模块复制进去，签名时一起签上 */
  afterPack(ctx) {
    const resources =
      ctx.electronPlatformName === 'darwin'
        ? join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`, 'Contents/Resources')
        : join(ctx.appOutDir, 'resources')
    cpSync('stage/server/node_modules', join(resources, 'server/node_modules'), { recursive: true })
  },
}
