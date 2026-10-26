import { describe, expect, it } from 'vite-plus/test'
import { audioSplitPlan, transcriptionSourceMatches, transcriptionSplitPlan } from './audioSegments'

describe('音频切分计划', () => {
  it('自定义切点保留精确时间，区间允许留空与复用', () => {
    expect(audioSplitPlan(10, 'cuts', '1.25, 0:04.5')).toEqual([
      { start: 0, end: 1.25 },
      { start: 1.25, end: 4.5 },
      { start: 4.5, end: 10 },
    ])
    expect(audioSplitPlan(10, 'ranges', '0 - 1.25\n4.5 - 8\n0 - 1')).toEqual([
      { start: 0, end: 1.25 },
      { start: 4.5, end: 8 },
      { start: 0, end: 1 },
    ])
  })
  it('未知时长、倒挂、出界与过多分段均不提交', () => {
    for (const [duration, mode, value] of [
      [undefined, 'cuts', '1'],
      [3, 'cuts', '2, 1'],
      [3, 'cuts', '3'],
      [3, 'ranges', '0-1\n2-4'],
      [3, 'ranges', '1-0\n1-2'],
      [30, 'cuts', Array.from({ length: 20 }, (_, i) => i + 1).join(',')],
    ] as const)
      expect(() => audioSplitPlan(duration, mode, value)).toThrow()
    expect(audioSplitPlan(10, 'even', '', 20)).toHaveLength(20)
  })
})

function job() {
  return {
    id: 'run',
    nodeId: 'asr',
    nodeType: 'plein/transcribe',
    status: 'succeeded',
    attempts: 1,
    createdAt: 0,
    input: {
      v: 1,
      nodeId: 'asr',
      nodeType: 'plein/transcribe',
      preparedAt: 0,
      status: 'ready',
      params: {},
      inputs: { audio: [{ type: 'audio', assetId: 'source' }] },
      refs: [],
      notices: [],
      blocked: [],
    },
  } as import('@plein/protocol').JobInfo
}

describe('识别分句计划', () => {
  it('仅接受同一成功作业的唯一冻结音频，额外资产或缺失历史均不能当作来源证明', () => {
    const good = job()
    expect(transcriptionSourceMatches(good, 'asr', 'run', 'source')).toBe(true)
    for (const bad of [
      { ...good, id: 'another-run' },
      { ...good, nodeId: 'another-node' },
      { ...good, nodeType: 'plein/speech' },
      { ...good, status: 'failed' as const },
      { ...good, input: undefined },
      { ...good, input: { ...good.input!, nodeId: 'another-node' } },
      { ...good, input: { ...good.input!, status: 'blocked' as const } },
      {
        ...good,
        input: {
          ...good.input!,
          inputs: { audio: [{ type: 'audio' as const, assetId: 'other' }] },
        },
      },
      {
        ...good,
        input: {
          ...good.input!,
          inputs: {
            audio: [
              { type: 'audio' as const, assetId: 'source' },
              { type: 'audio' as const, assetId: 'other' },
            ],
          },
        },
      },
      {
        ...good,
        input: {
          ...good.input!,
          inputs: {
            ...good.input!.inputs,
            reference: [{ type: 'audio' as const, assetId: 'source' }],
          },
        },
      },
      {
        ...good,
        input: {
          ...good.input!,
          inputs: {
            ...good.input!.inputs,
            reference: [{ type: 'video' as const, assetId: 'video' }],
          },
        },
      },
    ])
      expect(transcriptionSourceMatches(bad, 'asr', 'run', 'source')).toBe(false)
  })
  it('保留原始精度、空白和文本顺序，不把平台时间戳舍入成新的切点', () => {
    const data = {
      segments: [
        { start: 0.123456789, end: 1.234567891, text: '第一句' },
        { start: 2, end: 2.5, text: '第二句' },
      ],
    }
    const plan = transcriptionSplitPlan(data, 3)
    expect(plan.text).toBe('0.123456789 - 1.234567891\n2 - 2.5')
    expect(plan.segments).toEqual(data.segments)
    expect(plan.issue).toBeUndefined()
    expect(audioSplitPlan(3, 'ranges', plan.text)).toEqual(
      data.segments.map(({ start, end }) => ({ start, end })),
    )
  })
  it('少2或超过20句完整保留并说明需编辑，不悄悄截断、合并或补段', () => {
    const data = {
      segments: Array.from({ length: 21 }, (_, i) => ({ start: i, end: i + 0.5, text: `句${i}` })),
    }
    const many = transcriptionSplitPlan(data, 22)
    expect(many.text.split('\n')).toHaveLength(21)
    expect(many.issue).toContain('21')
    expect(() => audioSplitPlan(22, 'ranges', many.text)).toThrow('2–20')
    const one = transcriptionSplitPlan({ segments: data.segments.slice(0, 1) }, 22)
    expect(one.segments).toHaveLength(1)
    expect(one.issue).toContain('1 句')
  })
  it('时间戳错误、重叠、乱序、超长和未知时长均拒绝导入', () => {
    const row = { start: 0, end: 1, text: '一句' }
    for (const segments of [
      [],
      [{ ...row, start: NaN }],
      [{ ...row, end: Infinity }],
      [{ ...row, start: -1 }],
      [{ ...row, end: 0 }],
      [{ ...row, end: 5 }],
      [{ ...row, start: '0' }],
      [row, { ...row, start: 0.5, end: 2 }],
      [{ ...row, start: 2, end: 3 }, row],
    ])
      expect(() => transcriptionSplitPlan({ segments }, 4)).toThrow()
    expect(() => transcriptionSplitPlan({ segments: [row] }, undefined)).toThrow('时长')
  })
})
