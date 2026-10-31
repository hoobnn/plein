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

/** 写入桌面设置；失败只记警告，不影响调用方（端口和保存目录沿用这个容错） */
export function writePrefs(patch: Prefs): boolean {
  try {
    writeFileSync(prefsPath(), JSON.stringify({ ...readPrefs(), ...patch }, null, 2))
    return true
  } catch (err) {
    console.warn('无法保存桌面端设置', err)
    return false
  }
}

/** 更新偏好；文件缺失或损坏时用默认值 */
export function readUpdatePreferences(): DesktopUpdatePreferences {
  return readPrefs().updates ?? DEFAULT_UPDATE_PREFERENCES
}

/**
 * 保存更新偏好；取值不合法或写盘失败时不生效，返回 null 让调用方知道失败。
 * 偏好会决定下次启动是否自动检查，不能当作保存成功。
 */
export function writeUpdatePreferences(patch: unknown): DesktopUpdatePreferences | null {
  const current = readUpdatePreferences()
  const merged =
    typeof patch === 'object' && patch !== null ? { ...current, ...(patch as object) } : current
  const parsed = UpdatePreferences.safeParse(merged)
  if (!parsed.success) return null
  if (!writePrefs({ updates: parsed.data })) return null
  return parsed.data
}
