import { type CanvasTheme, DARK_THEME, LIGHT_THEME } from '@plein/canvas-core'
import { create } from 'zustand'

/** 主题偏好：跟随系统，或固定浅色 / 深色 */
export type ThemePref = 'system' | 'light' | 'dark'
export type ThemeName = 'light' | 'dark'

const KEY = 'plein:theme'
const media = window.matchMedia('(prefers-color-scheme: light)')

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // 隐私模式等读不到存储时跟随系统
  }
  return 'system'
}

const resolve = (pref: ThemePref): ThemeName =>
  pref === 'system' ? (media.matches ? 'light' : 'dark') : pref

/** 写到 <html data-theme>：CSS 令牌、原生控件和滚动条随之切换 */
function apply(name: ThemeName) {
  const root = document.documentElement
  root.dataset.theme = name
  root.style.colorScheme = name
}

interface ThemeStore {
  pref: ThemePref
  name: ThemeName
  setPref(pref: ThemePref): void
}

export const useTheme = create<ThemeStore>((set) => {
  const pref = readPref()
  const name = resolve(pref)
  apply(name)
  media.addEventListener('change', () => {
    const { pref } = useTheme.getState()
    if (pref !== 'system') return
    const next = resolve(pref)
    apply(next)
    set({ name: next })
  })
  return {
    pref,
    name,
    setPref(pref) {
      try {
        localStorage.setItem(KEY, pref)
      } catch {
        // 存不下就只在本次生效
      }
      const next = resolve(pref)
      apply(next)
      set({ pref, name: next })
    },
  }
})

/** 画布（GPU 层）的配色 */
export const canvasTheme = (name: ThemeName): CanvasTheme =>
  name === 'light' ? LIGHT_THEME : DARK_THEME
