import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  canUpdate,
  desktopDevelopment,
  initializeProfile,
  parseProfile,
  profileDataDir,
  profileIdentity,
  profileWindowChrome,
  readProfile,
} from '../src/profile.ts'
import { serverEnvironment } from '../src/server-env.ts'
import { packagedServerPaths } from '../src/packaged-resources.ts'

function temporary(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'plein-profile-contract-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

void test('profile 仅接受两个固定值；缺省正式版兼容', () => {
  assert.equal(parseProfile(undefined), 'production')
  assert.equal(parseProfile('production'), 'production')
  assert.equal(parseProfile('acceptance'), 'acceptance')
  for (const value of ['', null, 'development', '../production'])
    assert.throws(() => parseProfile(value), /production 或 acceptance/)
})

void test('验收身份与正式身份不同，正式输出名称兼容', () => {
  assert.deepEqual(profileIdentity('production'), {
    appId: 'com.ikuyu.plein',
    productName: 'Plein',
    runtimeName: 'plein',
    windowTitle: 'plein',
    output: 'release',
  })
  assert.equal(profileIdentity('acceptance').appId, 'com.ikuyu.plein.acceptance')
  assert.equal(profileIdentity('acceptance').productName, 'Plein Acceptance')
  assert.equal(profileIdentity('acceptance').output, 'release-acceptance')
  assert.match(profileIdentity('acceptance').windowTitle, /验收环境/)
})

void test('设置独立 userData 发生在 single-instance lock 之前；正式版不迁移数据', () =>
  temporary((dir) => {
    for (const profile of ['production', 'acceptance']) {
      const calls = []
      const app = {
        setName: (name) => calls.push(['name', name]),
        getPath: () => dir,
        setPath: (name, path) => calls.push([name, path]),
        setAppUserModelId: (id) => calls.push(['appId', id]),
        requestSingleInstanceLock: () => {
          calls.push(['lock'])
          return false
        },
      }
      assert.equal(initializeProfile(app, profile), false)
      assert.equal(calls.at(-1)[0], 'lock')
      assert.deepEqual(
        calls.filter(([name]) => name === 'userData'),
        profile === 'acceptance' ? [['userData', join(dir, 'Plein Acceptance')]] : [],
      )
    }
  }))

void test('打包后 profile 只来自包内元数据，不受继承环境变量切换', () =>
  temporary((dir) => {
    const previous = process.env.PLEIN_DESKTOP_PROFILE
    process.env.PLEIN_DESKTOP_PROFILE = 'acceptance'
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ pleinDesktopProfile: 'production' }),
      )
      assert.equal(readProfile(true, dir), 'production')
      assert.throws(() => readProfile(false, dir), /独立打包/)
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ pleinDesktopProfile: 'acceptance' }),
      )
      process.env.PLEIN_DESKTOP_PROFILE = 'production'
      assert.equal(readProfile(true, dir), 'acceptance')
      writeFileSync(join(dir, 'package.json'), '{}')
      assert.equal(readProfile(true, dir), 'production')
    } finally {
      if (previous === undefined) delete process.env.PLEIN_DESKTOP_PROFILE
      else process.env.PLEIN_DESKTOP_PROFILE = previous
    }
  }))

void test('验收包忽略生产业务数据 override；正式版仍支持显式数据目录', () => {
  assert.equal(profileDataDir('acceptance', '/acceptance', '/production/data'), '/acceptance/data')
  assert.equal(profileDataDir('production', '/production', '/custom'), '/custom')
  assert.equal(profileDataDir('production', '/production'), '/production/data')
})

void test('验收包始终禁用更新；正式版更新条件兼容', () => {
  for (const setting of [undefined, '0', '1'])
    assert.equal(canUpdate('acceptance', true, 'darwin', setting), false)
  assert.equal(canUpdate('production', true, 'darwin'), true)
  assert.equal(canUpdate('production', true, 'darwin', '0'), false)
  assert.equal(canUpdate('production', false, 'darwin'), false)
  assert.equal(canUpdate('production', true, 'linux'), false)
})

void test('实际 electron-builder 配置冻结身份、输出目录，验收包不写正式更新源', () =>
  temporary((dir) => {
    mkdirSync(join(dir, 'stage/server'), { recursive: true })
    mkdirSync(join(dir, 'stage/ffmpeg'), { recursive: true })
    writeFileSync(join(dir, 'stage/server/main.mjs'), '')
    writeFileSync(join(dir, 'stage/ffmpeg/ffmpeg'), '')
    mkdirSync(join(dir, 'stage/server/node_modules'), { recursive: true })
    const configUrl = new URL('../electron-builder.config.mjs', import.meta.url).href
    for (const profile of ['production', 'acceptance']) {
      const resources = join(dir, `${profile}.app`, 'Contents/Resources')
      mkdirSync(resources, { recursive: true })
      const code = `
      import config from ${JSON.stringify(configUrl)};
      import { existsSync } from 'node:fs';
      config.afterPack({ appOutDir: ${JSON.stringify(dir)}, electronPlatformName: 'darwin',
        packager: { appInfo: { productFilename: ${JSON.stringify(profile)} } } });
      console.log(JSON.stringify({ id: config.appId, name: config.productName,
        output: config.directories.output, metadata: config.extraMetadata,
        artifact: config.mac.artifactName,
        feed: existsSync(${JSON.stringify(join(resources, 'app-update.yml'))}) }));
    `
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PLEIN_DESKTOP_PROFILE: profile, PLEIN_VERSION: '0.9.0' },
      })
      assert.equal(child.status, 0, child.stderr)
      const config = JSON.parse(child.stdout)
      assert.equal(config.id, profileIdentity(profile).appId)
      assert.equal(config.name, profileIdentity(profile).productName)
      assert.equal(config.output, profileIdentity(profile).output)
      assert.equal(config.metadata.pleinDesktopProfile, profile)
      assert.equal(config.metadata.version, '0.9.0')
      assert.equal(config.feed, profile === 'production')
      assert.equal(
        config.artifact,
        profile === 'production'
          ? 'Plein-${version}-${arch}-mac.${ext}'
          : 'Plein-Acceptance-${version}-${arch}-mac.${ext}',
      )
    }
  }))

void test('验收包所有平台保留原生标题栏；正式 macOS 样式兼容', () => {
  for (const platform of ['darwin', 'linux', 'win32'])
    assert.deepEqual(profileWindowChrome('acceptance', platform), { titleBarStyle: 'default' })
  assert.deepEqual(profileWindowChrome('production', 'darwin'), {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 27 },
  })
})

void test('打包应用忽略继承的开发 env 与 --dev，未打包开发行为兼容', () => {
  for (const argv of [[], ['--dev']]) {
    for (const setting of [undefined, '0', '1'])
      assert.equal(desktopDevelopment(true, argv, setting), false)
  }
  assert.equal(desktopDevelopment(false, [], undefined), false)
  assert.equal(desktopDevelopment(false, ['--dev'], undefined), true)
  assert.equal(desktopDevelopment(false, [], '1'), true)
})

void test('打包子进程固定包内资源、独立数据与指定端口，不受陈旧环境覆盖', () => {
  const inherited = {
    PLEIN_DESKTOP_DEV: '1',
    PLEIN_DESKTOP_WEB_URL: 'http://localhost:5173',
    PLEIN_WEB_DIST: '/production/web',
    PLEIN_SUBTITLE_FONT: '/other/font.otf',
    PLEIN_FFMPEG_PATH: '/other/ffmpeg',
    PLEIN_FFPROBE_PATH: '/other/ffprobe',
    PLEIN_PORT: '8787',
    PLEIN_DATA_DIR: '/production/data',
    PLEIN_AUTH: 'password',
  }
  const paths = {
    entry: '/acceptance/server/main.mjs',
    cwd: '/acceptance/server',
    webDist: '/acceptance/web',
    ffmpeg: '/acceptance/ffmpeg',
    ffprobe: '/acceptance/ffprobe',
    subtitleFont: '/acceptance/font.otf',
  }
  const env = serverEnvironment(paths, {
    packaged: true,
    development: true,
    port: 34123,
    dataDir: '/acceptance/data',
    token: 'isolated',
    inherited,
  })
  assert.equal(env.PLEIN_PORT, '34123')
  assert.equal(env.PLEIN_DATA_DIR, '/acceptance/data')
  assert.equal(env.PLEIN_HOST, '127.0.0.1')
  assert.equal(env.PLEIN_AUTH, 'none')
  assert.equal(env.PLEIN_DESKTOP_TOKEN, 'isolated')
  assert.equal(env.PLEIN_DESKTOP_DEV, undefined)
  assert.equal(env.PLEIN_DESKTOP_WEB_URL, undefined)
  assert.equal(env.PLEIN_WEB_DIST, paths.webDist)
  assert.equal(env.PLEIN_SUBTITLE_FONT, paths.subtitleFont)
  assert.equal(env.PLEIN_FFMPEG_PATH, paths.ffmpeg)
  assert.equal(env.PLEIN_FFPROBE_PATH, paths.ffprobe)
  assert.equal(inherited.PLEIN_SUBTITLE_FONT, '/other/font.otf')
  assert.equal(
    serverEnvironment(paths, {
      packaged: true,
      development: true,
      port: 0,
      dataDir: '/acceptance/data',
      token: 'isolated',
      inherited,
    }).PLEIN_PORT,
    '0',
  )
})

void test('开发子进程继续支持显式资源覆盖与默认mock，包内缺资源不回退继承值', () => {
  const paths = {
    entry: '/repo/server/main.mjs',
    cwd: '/repo/server',
    subtitleFont: '/repo/font.otf',
  }
  const env = serverEnvironment(paths, {
    packaged: false,
    development: true,
    port: 0,
    dataDir: '/dev/data',
    token: 'dev',
    inherited: { PLEIN_SUBTITLE_FONT: '/custom/font.otf' },
  })
  assert.equal(env.PLEIN_PORT, '8787')
  assert.equal(env.PLEIN_SUBTITLE_FONT, '/custom/font.otf')
  assert.equal(env.PLEIN_MOCK_PROVIDER, '1')
  assert.throws(
    () =>
      serverEnvironment(paths, {
        packaged: true,
        development: false,
        port: 0,
        dataDir: '/acceptance/data',
        token: 'a',
        inherited: { PLEIN_WEB_DIST: '/other/web' },
      }),
    /安装包未声明资源路径：PLEIN_WEB_DIST/,
  )
})

function createBundle(dir) {
  for (const child of ['server', 'web', 'ffmpeg', 'fonts'])
    mkdirSync(join(dir, child), { recursive: true })
  const files = [
    join(dir, 'server/main.mjs'),
    join(dir, 'web/index.html'),
    join(dir, 'ffmpeg/ffmpeg'),
    join(dir, 'ffmpeg/ffprobe'),
    join(dir, 'fonts/NotoSansCJKsc-Regular.otf'),
  ]
  for (const file of files) writeFileSync(file, 'fixture', { mode: 0o700 })
  return files
}

void test('包内资源路径固定且完整；缺失任一文件明确失败而不借外部PATH', () =>
  temporary((dir) => {
    const files = createBundle(dir)
    const paths = packagedServerPaths(dir, 'darwin')
    assert.equal(paths.ffmpeg, join(dir, 'ffmpeg/ffmpeg'))
    assert.equal(paths.webDist, join(dir, 'web'))
    for (const file of files) {
      rmSync(file)
      assert.throws(
        () => packagedServerPaths(dir, 'darwin'),
        (error) => error.message.includes(file),
      )
      writeFileSync(file, 'fixture', { mode: 0o700 })
    }
  }))

void test('包内媒体二进制不可执行时在启动检查失败，不等到首次导出', () =>
  temporary((dir) => {
    createBundle(dir)
    chmodSync(join(dir, 'ffmpeg/ffmpeg'), 0o600)
    assert.throws(() => packagedServerPaths(dir, 'darwin'), /ffmpeg/)
  }))
