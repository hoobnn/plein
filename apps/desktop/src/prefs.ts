import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * 原子写：先写同目录临时文件，成功后再改名替换。
 * 直接覆盖原文件时，中途失败（磁盘满、权限）会把原文件截断，
 * 重启读到坏文件就会退回默认设置；改成先写临时文件，失败时原文件保持不变。
 */
function writeAtomic(path: string, content: string): boolean {
  const part = `${path}.part`
  try {
    writeFileSync(part, content)
    renameSync(part, path)
    return true
  } catch (err) {
    // 临时文件写不出来或改名失败：删掉临时文件，原文件不动
    try {
      rmSync(part, { force: true })
    } catch {
      // 临时文件删不掉时只能留给系统清理，原文件仍然是好的
    }
    console.warn('无法保存桌面端设置', err)
    return false
  }
}

/** 写入桌面设置；失败只记警告，不影响调用方（端口和保存目录沿用这个容错） */
export function writePrefs(patch: Prefs): boolean {
  return writeAtomic(prefsPath(), JSON.stringify({ ...readPrefs(), ...patch }, null, 2))
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
