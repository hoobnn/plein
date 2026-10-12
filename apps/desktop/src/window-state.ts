import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow, type Rectangle, screen } from 'electron'

const MIN_WIDTH = 800
const MIN_HEIGHT = 560
const statePath = () => join(app.getPath('userData'), 'window-state.json')

interface WindowState extends Rectangle {
  maximized: boolean
}

/** 显示器拔掉或分辨率变化后，仍让窗口完整落在可用的工作区内。 */
export function restoreWindowState() {
  let saved: WindowState | undefined
  try {
    const value = JSON.parse(readFileSync(statePath(), 'utf8')) as WindowState
    if (
      [value.x, value.y, value.width, value.height].every(Number.isFinite) &&
      value.width > 0 &&
      value.height > 0
    )
      saved = value
  } catch {
    // 首次启动或状态文件损坏时使用默认尺寸。
  }
  const area = (saved ? screen.getDisplayMatching(saved) : screen.getPrimaryDisplay()).workArea
  const width = Math.min(area.width, Math.max(MIN_WIDTH, saved?.width ?? 1440))
  const height = Math.min(area.height, Math.max(MIN_HEIGHT, saved?.height ?? 900))
  return {
    x: Math.max(
      area.x,
      Math.min(saved?.x ?? area.x + (area.width - width) / 2, area.x + area.width - width),
    ),
    y: Math.max(
      area.y,
      Math.min(saved?.y ?? area.y + (area.height - height) / 2, area.y + area.height - height),
    ),
    width,
    height,
    minWidth: Math.min(MIN_WIDTH, area.width),
    minHeight: Math.min(MIN_HEIGHT, area.height),
    maximized: saved?.maximized === true,
  }
}

export function trackWindowState(win: BrowserWindow) {
  const save = () => {
    try {
      writeFileSync(
        statePath(),
        JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }),
      )
    } catch (err) {
      console.warn('无法保存窗口状态', err)
    }
  }
  // 关闭时保存普通尺寸；最大化和全屏尺寸不能覆盖恢复尺寸。
  win.on('close', save)
}
