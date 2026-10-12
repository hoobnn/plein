import { describe, expect, it } from 'vitest'
import { findMentions, mentionQuery } from './mentions'

describe('@ 引用', () => {
  const targets = new Map([
    ['林夏', 1],
    ['林夏夏', 2],
    ['天台', 3],
  ])

  it('中文无空格时取最长匹配的名字', () => {
    const m = findMentions('@林夏夏站在@天台上，@路人 看着', targets)
    expect(m.map((x) => [x.name, x.target])).toEqual([
      ['林夏夏', 2],
      ['天台', 3],
    ])
    expect(m[1]).toMatchObject({ start: 6, end: 9 })
  })

  it('光标前正在输入的 @ 查询', () => {
    expect(mentionQuery('一个 @林', 5)).toEqual({ start: 3, query: '林' })
    expect(mentionQuery('一个 @林夏 走来', 9)).toBeNull()
    expect(mentionQuery('没有引用', 4)).toBeNull()
  })
})
