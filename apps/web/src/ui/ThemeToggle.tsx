import { type ThemePref, useTheme } from '../stores/theme'
import { Icon, type IconName } from './icons'

const OPTIONS: Array<{ pref: ThemePref; label: string; icon: IconName }> = [
  { pref: 'system', label: '跟随系统', icon: 'monitor' },
  { pref: 'light', label: '浅色', icon: 'sun' },
  { pref: 'dark', label: '深色', icon: 'moon' },
]

/** 主题切换：跟随系统 / 浅色 / 深色三段 */
export function ThemeToggle() {
  const pref = useTheme((s) => s.pref)
  const setPref = useTheme((s) => s.setPref)
  return (
    <fieldset aria-label="主题" className="m-0 flex items-center gap-0.5 rounded-lg border-0 p-0.5">
      {OPTIONS.map((o) => (
        <button
          key={o.pref}
          type="button"
          aria-pressed={pref === o.pref}
          aria-label={o.label}
          title={o.label}
          onClick={() => setPref(o.pref)}
          className={`flex size-7 items-center justify-center rounded-md transition-colors duration-150 ${
            pref === o.pref ? 'bg-active text-ink' : 'text-ink-subtle hover:text-ink'
          }`}
        >
          <Icon name={o.icon} size={15} />
        </button>
      ))}
    </fieldset>
  )
}
