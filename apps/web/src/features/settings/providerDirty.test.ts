import { describe, expect, it } from 'vite-plus/test'
import { providerDirty, sameSettings } from './providerDirty'

describe('平台设置的脏检查', () => {
  it('值相同就算没改，键的顺序不影响判断', () => {
    expect(sameSettings({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true)
    expect(sameSettings({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(sameSettings({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(sameSettings({ a: 1 }, { a: '1' })).toBe(false)
    expect(sameSettings({}, {})).toBe(true)
    expect(sameSettings(undefined, {})).toBe(true)
  })

  it('改过值、填过密钥或正在编辑数字都算未保存', () => {
    expect(providerDirty({ a: 1 }, { a: 1 }, {}, false)).toBe(false)
    expect(providerDirty({ a: 2 }, { a: 1 }, {}, false)).toBe(true)
    expect(providerDirty({ a: 1 }, { a: 1 }, { key: 'v' }, false)).toBe(true)
    expect(providerDirty({ a: 1 }, { a: 1 }, { key: '' }, false)).toBe(false)
    expect(providerDirty({ a: 1 }, { a: 1 }, {}, true)).toBe(true)
  })

  it('服务端回传的键序与本地不同，不误报未保存', () => {
    // 删掉一个字段再填回去：新键排到了末尾，与服务端保存的顺序不同
    expect(
      providerDirty({ queueMs: 20, latencyMs: 300 }, { latencyMs: 300, queueMs: 20 }, {}, false),
    ).toBe(false)
  })
})
