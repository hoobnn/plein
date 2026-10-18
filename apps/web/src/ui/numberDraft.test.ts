import { describe, expect, it } from 'vite-plus/test'
import { clampNumber, resolveNumberDraft } from './numberDraft'

const range = { type: 'number', minimum: 0, maximum: 2 }

describe('数值草稿提交合同', () => {
  it('空输入仅在浏览器确认不是无效数值且基线未变时才恢复默认', () => {
    const draft = { text: '', base: 1.1 }
    expect(resolveNumberDraft(draft, 1.1, range, false)).toEqual({
      kind: 'commit',
      value: undefined,
    })
    expect(resolveNumberDraft(draft, 1.1, range, true)).toEqual({ kind: 'invalid' })
    expect(resolveNumberDraft(draft, 0.4, range, false)).toEqual({ kind: 'conflict' })
    expect(resolveNumberDraft(draft, 0.4, range, true, true)).toEqual({ kind: 'invalid' })
  })
  it('变化的值与删除字段都先阻断，明确保留草稿才能覆盖；同值通知不产生冲突', () => {
    const draft = { text: '1.6', base: 1.1 }
    for (const current of [0, 0.4, undefined]) {
      expect(resolveNumberDraft(draft, current, range, false)).toEqual({ kind: 'conflict' })
      expect(resolveNumberDraft(draft, current, range, false, true)).toEqual({
        kind: 'commit',
        value: 1.6,
      })
    }
    expect(resolveNumberDraft(draft, 1.1, range, false)).toEqual({ kind: 'commit', value: 1.6 })
    expect(resolveNumberDraft({ text: '0', base: undefined }, undefined, range, false)).toEqual({
      kind: 'commit',
      value: 0,
    })
  })
  it('非有限值与未完成表达式不能成为保存值，即使用户选择覆盖', () => {
    for (const text of ['1e', '-', 'NaN', 'Infinity', '1e999']) {
      expect(resolveNumberDraft({ text, base: 1 }, 1, range, false)).toEqual({ kind: 'invalid' })
      expect(resolveNumberDraft({ text, base: 1 }, 2, range, false, true)).toEqual({
        kind: 'invalid',
      })
    }
  })
  it('有限数值取整与夹紧幂等且始终处于约定范围，未限定范围保留小数', () => {
    for (const type of ['number', 'integer']) {
      const bounds = { type, minimum: -2, maximum: 3 }
      for (let value = -10; value <= 10; value += 0.125) {
        const saved = clampNumber(bounds, value)
        expect(saved).toBeGreaterThanOrEqual(-2)
        expect(saved).toBeLessThanOrEqual(3)
        if (type === 'integer') expect(Number.isInteger(saved)).toBe(true)
        expect(clampNumber(bounds, saved)).toBe(saved)
        expect(resolveNumberDraft({ text: String(value), base: 1 }, 1, bounds, false)).toEqual({
          kind: 'commit',
          value: saved,
        })
      }
    }
    expect(clampNumber({}, 1.125)).toBe(1.125)
  })
})
