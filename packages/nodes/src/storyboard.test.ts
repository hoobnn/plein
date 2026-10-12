import { describe, expect, it } from 'vitest'
import { mergeShots, type Shot } from './storyboard'

const shot = (no: number, description: string, edited?: boolean): Shot => ({
  id: `s${no}`,
  no,
  duration: 5,
  shotSize: '中景',
  description,
  characters: [],
  emotion: '',
  lighting: '',
  sfx: '',
  dialogue: [],
  imagePrompt: '',
  motionPrompt: '',
  ...(edited ? { edited } : {}),
})

describe('分镜合并', () => {
  it('按镜号对齐：沿用 id，手改的行不覆盖，新增镜头拿新 id', () => {
    const merged = mergeShots(
      [shot(1, '旧一'), shot(2, '我改过', true), shot(5, '手加的', true)],
      [
        { no: 1, description: '新一' },
        { no: 2, description: '新二' },
        { no: 3, description: '新三' },
      ],
    )
    expect(merged.map((s) => [s.no, s.description])).toEqual([
      [1, '新一'],
      [2, '我改过'],
      [3, '新三'],
      [5, '手加的'],
    ])
    expect(merged[0]!.id).toBe('s1')
    expect(merged[2]!.id).toMatch(/^shot_/)
    expect(merged[2]!.shotSize).toBe('中景')
  })
})
