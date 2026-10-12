import { desktop } from '../desktop'

export const isMac = desktop ? desktop.platform === 'darwin' : /Mac/i.test(navigator.platform)

/** 主修饰键：配合鼠标、触控板的操作写成「⌘ + 滚轮」 */
export const MOD = isMac ? '⌘' : 'Ctrl'

/** macOS 按系统菜单的顺序和符号写修饰键（⌃⌥⇧⌘），其他平台写成 Ctrl+Shift+Z */
const MODIFIERS = [
  { id: 'ctrl', mac: '⌃', other: 'Ctrl' },
  { id: 'alt', mac: '⌥', other: 'Alt' },
  { id: 'shift', mac: '⇧', other: 'Shift' },
  { id: 'mod', mac: '⌘', other: 'Ctrl' },
] as const

const KEYS: Record<string, { mac: string; other: string }> = {
  enter: { mac: '↵', other: 'Enter' },
  backspace: { mac: '⌫', other: 'Backspace' },
  esc: { mac: 'Esc', other: 'Esc' },
  tab: { mac: 'Tab', other: 'Tab' },
  space: { mac: '空格', other: '空格' },
  plus: { mac: '+', other: '+' },
  minus: { mac: '−', other: '−' },
}

/**
 * 快捷键的显示文本，`mod` 在 macOS 是 ⌘、其他平台是 Ctrl：
 * `shortcut('mod+shift+z')` → macOS「⇧⌘Z」，Windows「Ctrl+Shift+Z」。
 */
export function shortcut(spec: string) {
  const parts = spec.toLowerCase().split('+')
  const key = parts.at(-1) ?? ''
  const mods = MODIFIERS.filter((m) => parts.slice(0, -1).includes(m.id))
  const name = KEYS[key]?.[isMac ? 'mac' : 'other'] ?? key.toUpperCase()
  return isMac
    ? `${mods.map((m) => m.mac).join('')}${name}`
    : [...mods.map((m) => m.other), name].join('+')
}

/** 「名称（快捷键）」：按钮的悬停提示 */
export const withShortcut = (label: string, spec?: string) =>
  spec ? `${label}（${shortcut(spec)}）` : label
