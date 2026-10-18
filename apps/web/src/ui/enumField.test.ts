import { describe, expect, it } from 'vite-plus/test'
import { enumField } from './enumField'

describe('表单枚举保留类型', () => {
  it('同样显示为 1 的数字与字符串、false、零值、null 与默认占位符保持身份', () => {
    const values = [0, 1, '1', false, true, null, '__default', 'default', 'option:0']
    for (const current of values) {
      const field = enumField(values, current)
      expect(field.read(field.value)).toBe(current)
      expect(field.options.find((option) => option.value === field.value)?.label).toBe(
        String(current),
      )
    }
    expect(new Set(enumField(values, 0).options.map((option) => option.value)).size).toBe(
      values.length,
    )
  })
  it('未设置使用默认，占位符不覆盖真实选项；标签只影响显示', () => {
    const field = enumField([0, 100], undefined, { '0': '即时', '100': '稍后' })
    expect(field.value).toBe('default')
    expect(field.read('default')).toBeUndefined()
    expect(field.options.map((option) => option.label)).toEqual(['即时', '稍后'])
    expect(field.read(field.options[1]!.value)).toBe(100)
  })
  it('未知历史值原样展示直到明确替换，不误选第一项', () => {
    const field = enumField([0, 'other'], 'option:0')
    expect(field.value).toBe('unknown')
    expect(field.options.at(-1)?.label).toBe('option:0')
    expect(field.read(field.value)).toBe('option:0')
    expect(field.read(field.options[0]!.value)).toBe(0)
    expect(field.read('missing')).toBeUndefined()
  })
})
