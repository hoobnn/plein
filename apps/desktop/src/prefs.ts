import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
}

const prefsPath = () => join(app.getPath('userData'), 'desktop.json')

export function readPrefs(): Prefs {
  try {
    const value: unknown = JSON.parse(readFileSync(prefsPath(), 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const { port, saveDir } = value as Record<string, unknown>
    return {
      ...(typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535
        ? { port }
        : {}),
      ...(typeof saveDir === 'string' && saveDir.length > 0 ? { saveDir } : {}),
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
