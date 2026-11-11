import { expect, it } from 'vite-plus/test'
import { dismissShortcutHint, shouldShowShortcutHint } from './hintStorage'

function memory(): Storage {
  const data = new Map<string, string>()
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  } as Storage
}

it('关闭后不再提示，存储不可用时也不打扰', () => {
  const store = memory()
  expect(shouldShowShortcutHint(store)).toBe(true)
  dismissShortcutHint(store)
  expect(shouldShowShortcutHint(store)).toBe(false)
  const broken = {
    getItem() {
      throw new Error('blocked')
    },
    setItem() {
      throw new Error('blocked')
    },
  }
  expect(shouldShowShortcutHint(broken)).toBe(false)
  expect(() => dismissShortcutHint(broken)).not.toThrow()
})
