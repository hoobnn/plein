import { describe, expect, it } from 'vite-plus/test'
import { composingKey } from './composingKey'

describe('组字中的按键判断', () => {
  it('组字中（isComposing）不算普通按键', () => {
    expect(composingKey({ isComposing: true })).toBe(true)
  })

  it('组字中（keyCode 229）不算普通按键', () => {
    expect(composingKey({ keyCode: 229 })).toBe(true)
  })

  it('两种信号都没有时是普通按键', () => {
    expect(composingKey({})).toBe(false)
    expect(composingKey({ isComposing: false })).toBe(false)
    expect(composingKey({ keyCode: 13 })).toBe(false)
    expect(composingKey({ isComposing: false, keyCode: 0 })).toBe(false)
  })
})
