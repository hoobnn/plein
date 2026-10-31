import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_UPDATE_PREFERENCES,
  UpdatePreferences,
  type DesktopUpdatePreferences,
} from '@plein/protocol'
import { app } from 'electron'

/** 桌面端自己的小设置，存在 <userData>/desktop.json；画布数据仍在数据目录里 */
interface Prefs {
  /**
   * 上次服务端用的端口。网页的 localStorage（主题、侧栏、智能体选择）按源保存，
   * 端口每次都换的话这些设置每次启动都会丢，所以尽量沿用同一个端口。
   */
  port?: number
  /** 上次另存为选的目录 */
  saveDir?: string
  /** 自动更新偏好 */
  updates?: DesktopUpdatePreferences
}

const prefsPath = () => join(app.getPath('userData'), 'desktop.json')

export function readPrefs(): Prefs {
  try {
    const value: unknown = JSON.parse(readFileSync(prefsPath(), 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const { port, saveDir, updates } = value as Record<string, unknown>
    const parsed = UpdatePreferences.safeParse(updates)
    return {
      ...(typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535
        ? { port }
        : {}),
      ...(typeof saveDir === 'string' && saveDir.length > 0 ? { saveDir } : {}),
      ...(parsed.success ? { updates: parsed.data } : {}),
    }
  } catch {
    return {}
  }
}

export function writePrefs(patch: Prefs) {
  try {
    writeFileSync(prefsPath(), JSON.stringify({ ...readPrefs(), ...patch }, null, 2))
  } catch (err) {
    console.warn('无法保存桌面端设置', err)
  }
}

/** 更新偏好；文件缺失或损坏时用默认值 */
export function readUpdatePreferences(): DesktopUpdatePreferences {
  return readPrefs().updates ?? DEFAULT_UPDATE_PREFERENCES
}

/** 保存更新偏好；取值不合法时不写入，保留原设置 */
export function writeUpdatePreferences(patch: unknown): DesktopUpdatePreferences {
  const current = readUpdatePreferences()
  const merged =
    typeof patch === 'object' && patch !== null ? { ...current, ...(patch as object) } : current
  const parsed = UpdatePreferences.safeParse(merged)
  if (!parsed.success) return current
  writePrefs({ updates: parsed.data })
  return parsed.data
}
