import { type ThemePref, useTheme } from '../stores/theme'
import type { IconName } from './icons'
import { Segmented } from './Segmented'

export const THEME_OPTIONS: Array<{ pref: ThemePref; label: string; icon: IconName }> = [
  { pref: 'system', label: '跟随系统', icon: 'monitor' },
  { pref: 'light', label: '浅色', icon: 'sun' },
  { pref: 'dark', label: '深色', icon: 'moon' },
]

const OPTIONS = THEME_OPTIONS.map((o) => ({ value: o.pref, label: o.label, icon: o.icon }))

/** 主题切换：跟随系统 / 浅色 / 深色三段的分段控件 */
export function ThemeToggle() {
  const pref = useTheme((s) => s.pref)
  const setPref = useTheme((s) => s.setPref)
  return <Segmented label="主题" iconOnly options={OPTIONS} value={pref} onChange={setPref} />
}
