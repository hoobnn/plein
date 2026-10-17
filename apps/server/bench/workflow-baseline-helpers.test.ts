import { describe, expect, it } from 'vite-plus/test'
import {
  candidateDelta,
  countBaselineSubmits,
  CreativeBaselineFixture,
  type BaselineSubmit,
} from './workflow-baseline-helpers'

const event = (
  id: string,
  capability: string,
  outcome?: BaselineSubmit['outcome'],
): BaselineSubmit => ({
  id,
  fixtureId: 'synthetic-unit-only',
  phase: 'unit',
  capability,
  model: 'mock',
  startedAt: 1,
  outcome,
})
describe('可运行机器基线的计数口径', () => {
  it('按真实submit入口事件计数，失败也保留，不根据候选数量估算调用', () => {
    const submits = [
      event('a', 'image.generate', 'succeeded'),
      event('b', 'video.generate', 'threw'),
      event('c', 'video.generate', 'pending'),
    ]
    expect(countBaselineSubmits(submits)).toEqual({
      total: 3,
      video: 2,
      byCapability: { 'image.generate': 1, 'video.generate': 2 },
    })
    expect(() => countBaselineSubmits([...submits, submits[0]!])).toThrow('重复')
  })
  it('局部返工区分新增候选与旧候选丢失，内容去重也不能抹掉候选身份', () => {
    expect(
      candidateDelta(
        { image: ['image-old'], video: ['video-old'] },
        { image: ['image-old'], video: ['video-new', 'video-old'] },
      ),
    ).toEqual({ removed: [], added: [{ nodeId: 'video', resultId: 'video-new' }] })
    expect(candidateDelta({ video: ['video-old'] }, { video: ['video-new'] }).removed).toEqual([
      { nodeId: 'video', resultId: 'video-old' },
    ])
  })
  it('运行器拒绝非固定格式输入，不读取未知fixture格式', () => {
    expect(CreativeBaselineFixture.safeParse({ format: 'unknown', shots: [] }).success).toBe(false)
  })
})
