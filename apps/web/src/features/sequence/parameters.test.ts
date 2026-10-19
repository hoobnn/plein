import { describe, expect, it } from 'vite-plus/test'
import { sequenceParameterProblem } from './parameters'

describe('序列参数恢复建议', () => {
  it('有效参数不需要恢复，也不写入默认值', () => {
    const value = { clips: [], resolution: '720p' }
    expect(sequenceParameterProblem(value)).toBeNull()
    expect(value).toEqual({ clips: [], resolution: '720p' })
    expect(sequenceParameterProblem(undefined)).toBeNull()
  })
  it('只重置无效标量，保留镜头、画幅和扩展字段', () => {
    const value = { resolution: '8K', aspectRatio: '16:9', clips: [{ source: 'a' }], extra: 1 }
    expect(sequenceParameterProblem(value)).toMatchObject({
      whole: false,
      lists: false,
      labels: ['分辨率'],
      patch: { resolution: '1080p' },
    })
    expect(value.resolution).toBe('8K')
  })
  it('无效嵌套项重置整个列表，样片不重置来源分镜', () => {
    expect(
      sequenceParameterProblem({ boardId: 'keep', clips: [{ source: 'a', in: -1 }] }, true),
    ).toMatchObject({ lists: true, patch: { clips: [] } })
    expect(
      sequenceParameterProblem({ boardId: 'keep', clips: [{ source: 'a', in: -1 }] }, true)?.patch,
    ).not.toHaveProperty('boardId')
  })
  it('无效可选字幕轨通过删除字段恢复，而非写入空对象', () => {
    expect(sequenceParameterProblem({ subtitleTrack: {} })?.patch).toEqual({
      subtitleTrack: undefined,
    })
  })
  it('整个参数不是对象时明确重置全部参数', () => {
    for (const value of [null, [], 'invalid']) {
      expect(sequenceParameterProblem(value)).toMatchObject({
        whole: true,
        patch: { clips: [], resolution: '1080p' },
      })
    }
  })
})
