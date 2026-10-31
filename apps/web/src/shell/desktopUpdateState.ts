import type { DesktopUpdatePreferences, DesktopUpdateState } from '@plein/protocol'
import { create } from 'zustand'

export type UpdateAction = 'check' | 'download' | 'install'

/** 菜单先记录打开意图，更新面板的懒加载不会吞掉命令。 */
export const useUpdate = create<{
  state: DesktopUpdateState | null
  /** 自动检查偏好；主进程保存，页面只读改 */
  preferences: DesktopUpdatePreferences | null
  open: boolean
  pending: UpdateAction | 'read' | null
  bridgeError: string | null
}>(() => ({ state: null, preferences: null, open: false, pending: null, bridgeError: null }))
