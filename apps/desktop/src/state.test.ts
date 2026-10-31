import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { readPrefs, readUpdatePreferences, writePrefs, writeUpdatePreferences } from './prefs'
import { restoreWindowState, trackWindowState } from './window-state'

const electron = vi.hoisted(() => ({
  dir: '',
  screen: { getPrimaryDisplay: vi.fn(), getDisplayMatching: vi.fn() },
}))
/** 模拟磁盘故障：临时文件写不进去、改名失败、临时文件删不掉 */
const disk = vi.hoisted(() => ({ failPart: false, failRename: false, failCleanup: false }))
vi.mock('electron', () => ({
  app: { getPath: () => electron.dir },
  screen: electron.screen,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const write = actual.writeFileSync as (...args: unknown[]) => void
  const rename = actual.renameSync as (...args: unknown[]) => void
  const rm = actual.rmSync as (...args: unknown[]) => void
  return {
    ...actual,
    writeFileSync: (path: unknown, ...rest: unknown[]) => {
      // 模拟磁盘满：写到一半就报错，直接覆盖原文件时会把原文件截断
      if (disk.failPart && String(path).startsWith(electron.dir)) {
        const data = rest[0]
        write(path, typeof data === 'string' ? data.slice(0, 8) : data)
        throw new Error('磁盘已满')
      }
      write(path, ...rest)
    },
    renameSync: (from: unknown, to: unknown) => {
      if (disk.failRename) throw new Error('改名失败')
      rename(from, to)
    },
    rmSync: (path: unknown, ...rest: unknown[]) => {
      if (disk.failCleanup && String(path).endsWith('.part')) throw new Error('临时文件删不掉')
      rm(path, ...rest)
    },
  }
})

beforeEach(() => {
  electron.dir = mkdtempSync(join(tmpdir(), 'plein-desktop-state-'))
  disk.failPart = false
  disk.failRename = false
  disk.failCleanup = false
  const display = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
  electron.screen.getPrimaryDisplay.mockReturnValue(display)
  electron.screen.getDisplayMatching.mockReturnValue(display)
})
afterEach(() => {
  rmSync(electron.dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('桌面设置', () => {
  it.each(['null', '[]', '42', '"text"', '{broken'])('损坏或非对象设置 %s 可恢复', (json) => {
    writeFileSync(join(electron.dir, 'desktop.json'), json)
    expect(readPrefs()).toEqual({})
    writePrefs({ port: 8790 })
    expect(readPrefs()).toEqual({ port: 8790 })
  })

  it.each([0, -1, 1.5, 65536, '8790', null])('忽略非法端口 %s，保留有效目录', (port) => {
    writeFileSync(
      join(electron.dir, 'desktop.json'),
      JSON.stringify({ port, saveDir: '/tmp/作品', unknown: true }),
    )
    expect(readPrefs()).toEqual({ saveDir: '/tmp/作品' })
  })

  it('首次读取使用空设置，补丁保存保留已有有效字段', () => {
    expect(readPrefs()).toEqual({})
    writePrefs({ port: 65535 })
    writePrefs({ saveDir: '/tmp/作品' })
    expect(readPrefs()).toEqual({ port: 65535, saveDir: '/tmp/作品' })
  })

  it.each(['', 123, null])('忽略非法保存目录 %s', (saveDir) => {
    writeFileSync(join(electron.dir, 'desktop.json'), JSON.stringify({ port: 1, saveDir }))
    expect(readPrefs()).toEqual({ port: 1 })
  })

  it('无法写入时记录错误而不阻断应用', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    rmSync(electron.dir, { recursive: true })
    expect(() => writePrefs({ port: 8790 })).not.toThrow()
    expect(warn).toHaveBeenCalledWith('无法保存桌面端设置', expect.any(Error))
    warn.mockRestore()
  })
})

describe('更新偏好', () => {
  it('没有偏好时用默认值', () => {
    expect(readUpdatePreferences()).toEqual({ checkOnLaunch: true, intervalHours: 6 })
  })

  it('保存偏好时保留其他桌面设置', () => {
    writePrefs({ port: 8790 })
    expect(writeUpdatePreferences({ checkOnLaunch: false, intervalHours: 3 })).toEqual({
      checkOnLaunch: false,
      intervalHours: 3,
    })
    expect(readPrefs()).toEqual({
      port: 8790,
      updates: { checkOnLaunch: false, intervalHours: 3 },
    })
    expect(readUpdatePreferences()).toEqual({ checkOnLaunch: false, intervalHours: 3 })
  })

  it('损坏或非法的偏好回退默认值，非法取值不写入', () => {
    writeFileSync(
      join(electron.dir, 'desktop.json'),
      JSON.stringify({ updates: { checkOnLaunch: 'yes', intervalHours: 5 } }),
    )
    expect(readUpdatePreferences()).toEqual({ checkOnLaunch: true, intervalHours: 6 })
    expect(writeUpdatePreferences({ intervalHours: 5 })).toBeNull()
    expect(readUpdatePreferences()).toEqual({ checkOnLaunch: true, intervalHours: 6 })
  })

  it('写盘失败时不更新偏好，调用方能知道失败', () => {
    expect(writeUpdatePreferences({ intervalHours: 3 })).toEqual({
      checkOnLaunch: true,
      intervalHours: 3,
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    rmSync(electron.dir, { recursive: true })
    expect(writeUpdatePreferences({ intervalHours: 12 })).toBeNull()
    expect(warn).toHaveBeenCalledWith('无法保存桌面端设置', expect.any(Error))
    warn.mockRestore()
  })

  it('临时文件写不进去时原文件内容不变', () => {
    writeUpdatePreferences({ checkOnLaunch: false, intervalHours: 0 })
    const path = join(electron.dir, 'desktop.json')
    const before = readFileSync(path, 'utf8')
    disk.failPart = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(writeUpdatePreferences({ checkOnLaunch: true, intervalHours: 24 })).toBeNull()
    expect(writePrefs({ port: 8790 })).toBe(false)
    warn.mockRestore()
    // 原文件仍是旧内容，偏好不会被改成默认值
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(readUpdatePreferences()).toEqual({ checkOnLaunch: false, intervalHours: 0 })
    expect(existsSync(`${path}.part`)).toBe(false)
  })

  it('改名失败时删掉临时文件并保留原文件', () => {
    writePrefs({ port: 8790 })
    const path = join(electron.dir, 'desktop.json')
    const before = readFileSync(path, 'utf8')
    disk.failRename = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(writePrefs({ port: 8791 })).toBe(false)
    warn.mockRestore()
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(readPrefs()).toEqual({ port: 8790 })
    expect(existsSync(`${path}.part`)).toBe(false)
  })

  it('临时文件删不掉时仍保留原文件', () => {
    writePrefs({ port: 8790 })
    const path = join(electron.dir, 'desktop.json')
    const before = readFileSync(path, 'utf8')
    disk.failRename = true
    disk.failCleanup = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(writePrefs({ port: 8791 })).toBe(false)
    warn.mockRestore()
    expect(readFileSync(path, 'utf8')).toBe(before)
  })
})

describe('窗口状态', () => {
  it('首次启动在主显示器居中', () => {
    expect(restoreWindowState()).toEqual({
      x: 240,
      y: 90,
      width: 1440,
      height: 900,
      minWidth: 800,
      minHeight: 560,
      maximized: false,
    })
  })

  it.each(['null', '{broken', '{"x":0,"y":0,"width":-1,"height":900}'])(
    '损坏的窗口状态 %s 回退默认尺寸',
    (json) => {
      writeFileSync(join(electron.dir, 'window-state.json'), json)
      expect(restoreWindowState()).toMatchObject({ width: 1440, height: 900, maximized: false })
      expect(electron.screen.getDisplayMatching).not.toHaveBeenCalled()
    },
  )

  it('显示器拔除后将越界的大窗口移回可用区域', () => {
    writeFileSync(
      join(electron.dir, 'window-state.json'),
      JSON.stringify({
        x: 3000,
        y: 2000,
        width: 2400,
        height: 1400,
        maximized: true,
      }),
    )
    electron.screen.getDisplayMatching.mockReturnValue({
      workArea: { x: -1280, y: 30, width: 1280, height: 720 },
    })
    expect(restoreWindowState()).toEqual({
      x: -1280,
      y: 30,
      width: 1280,
      height: 720,
      minWidth: 800,
      minHeight: 560,
      maximized: true,
    })
  })

  it('小工作区同时约束默认尺寸和最小尺寸', () => {
    electron.screen.getPrimaryDisplay.mockReturnValue({
      workArea: { x: 10, y: 20, width: 640, height: 480 },
    })
    expect(restoreWindowState()).toEqual({
      x: 10,
      y: 20,
      width: 640,
      height: 480,
      minWidth: 640,
      minHeight: 480,
      maximized: false,
    })
  })

  it('关闭窗口保存普通尺寸，恢复最大化标记', () => {
    const win = Object.assign(new EventEmitter(), {
      getNormalBounds: () => ({ x: 20, y: 30, width: 900, height: 600 }),
      isMaximized: () => true,
    })
    trackWindowState(win as unknown as BrowserWindow)
    win.emit('close')
    expect(JSON.parse(readFileSync(join(electron.dir, 'window-state.json'), 'utf8'))).toEqual({
      x: 20,
      y: 30,
      width: 900,
      height: 600,
      maximized: true,
    })
    expect(restoreWindowState()).toMatchObject({ width: 900, height: 600, maximized: true })
  })

  it('关闭时无法保存状态不阻断退出', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const win = Object.assign(new EventEmitter(), {
      getNormalBounds: () => ({ x: 20, y: 30, width: 900, height: 600 }),
      isMaximized: () => false,
    })
    trackWindowState(win as unknown as BrowserWindow)
    rmSync(electron.dir, { recursive: true })
    expect(() => win.emit('close')).not.toThrow()
    expect(warn).toHaveBeenCalledWith('无法保存窗口状态', expect.any(Error))
    warn.mockRestore()
  })
})
