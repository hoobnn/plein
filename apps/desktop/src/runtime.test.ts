import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { checkRuntime, installRuntime } from '../scripts/runtime'

let dir: string
const relative =
  process.platform === 'win32' ? 'electron.exe' : 'Electron.app/Contents/MacOS/Electron'
function binary(root = join(dir, 'dist'), path = relative) {
  const file = join(root, path)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, 'fixture: never execute this file', { mode: 0o755 })
  return file
}
function ready(version = '44.8.0') {
  binary()
  writeFileSync(join(dir, 'path.txt'), relative)
  writeFileSync(join(dir, 'dist/version'), version)
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-runtime-check-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '44.8.0' }))
  writeFileSync(join(dir, 'index.js'), 'throw new Error("must not import electron")')
  writeFileSync(
    join(dir, 'install.js'),
    'require("node:fs").writeFileSync(__dirname + "/installed", "yes")',
  )
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('本地桌面运行时', () => {
  it('只读检查缺失安装，不触发 index 自动下载或安装器', () => {
    expect(() => checkRuntime(dir, '')).toThrow('Electron 44.8.0 本地运行时不可用')
    expect(() => checkRuntime(dir, '')).toThrow('runtime:install')
    expect(existsSync(join(dir, 'installed'))).toBe(false)
  })
  it('接受匹配版本和带 v 的版本记录，不运行二进制', () => {
    ready('v44.8.0\n')
    expect(checkRuntime(dir, '')).toEqual({
      version: '44.8.0',
      executable: join(dir, 'dist', relative),
    })
  })
  it('安装记录存在但二进制缺失时拒绝启动', () => {
    ready()
    rmSync(join(dir, 'dist', relative))
    expect(() => checkRuntime(dir, '')).toThrow('runtime:install')
  })
  it('拒绝空路径和目录，不能把可遍历的目录当作二进制', () => {
    ready()
    writeFileSync(join(dir, 'path.txt'), '')
    expect(() => checkRuntime(dir, '')).toThrow('path.txt 为空')
    mkdirSync(join(dir, 'dist/Electron.app'), { recursive: true })
    writeFileSync(join(dir, 'path.txt'), 'Electron.app')
    expect(() => checkRuntime(dir, '')).toThrow('运行时路径不是可执行文件')
  })
  it('拒绝缓存中不同版本，不悄悄回退到已有版本', () => {
    ready('44.9.0')
    expect(() => checkRuntime(dir, '')).toThrow('二进制版本 44.9.0，与依赖版本不一致')
  })
  it.skipIf(process.platform === 'win32')('二进制不能执行时拒绝启动', () => {
    ready()
    chmodSync(join(dir, 'dist', relative), 0o644)
    expect(() => checkRuntime(dir, '')).toThrow('runtime:install')
  })
  it('保留 Electron 显式 override 的路径语义', () => {
    ready()
    const override = join(dir, 'custom runtime')
    const file = binary(override)
    expect(checkRuntime(dir, override).executable).toBe(file)
    rmSync(join(dir, 'path.txt'))
    const fallback = binary(override, 'electron')
    expect(checkRuntime(dir, override).executable).toBe(fallback)
  })
  it('显式安装委派给当前包并重新核实结果', () => {
    writeFileSync(
      join(dir, 'install.js'),
      `
      const fs = require('node:fs'); const path = require('node:path');
      const file = path.join(__dirname, 'dist', ${JSON.stringify(relative)});
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'fixture', { mode: 0o755 });
      fs.writeFileSync(path.join(__dirname, 'dist/version'), '44.8.0');
      fs.writeFileSync(path.join(__dirname, 'path.txt'), ${JSON.stringify(relative)});
    `,
    )
    expect(installRuntime(dir).version).toBe('44.8.0')
  })
  it('安装器失败时保留明确失败结果', () => {
    writeFileSync(join(dir, 'install.js'), 'process.exit(17)')
    expect(() => installRuntime(dir)).toThrow('安装未完成（17）')
  })
  it('安装器成功退出但未安装完整时不报告成功', () => {
    expect(() => installRuntime(dir)).toThrow('缺少 path.txt')
    expect(existsSync(join(dir, 'installed'))).toBe(true)
  })
})
