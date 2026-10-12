import { type ThemePref, useTheme } from '../stores/theme'
import { Icon, type IconName } from './icons'

const OPTIONS: Array<{ pref: ThemePref; label: string; icon: IconName }> = [
  { pref: 'system', label: '跟随系统', icon: 'monitor' },
  { pref: 'light', label: '浅色', icon: 'sun' },
  { pref: 'dark', label: '深色', icon: 'moon' },
]

/** 主题切换：跟随系统 / 浅色 / 深色三段的分段控件 */
export function ThemeToggle() {
  const pref = useTheme((s) => s.pref)
  const setPref = useTheme((s) => s.setPref)
  return (
    <fieldset aria-label="主题" className="ui-seg">
      {OPTIONS.map((o) => (
        <button
          key={o.pref}
          type="button"
          aria-pressed={pref === o.pref}
          aria-label={o.label}
          title={o.label}
          onClick={() => setPref(o.pref)}
          className="ui-seg-item w-7"
        >
          <Icon name={o.icon} size={14} />
        </button>
      ))}
    </fieldset>
  )
}
