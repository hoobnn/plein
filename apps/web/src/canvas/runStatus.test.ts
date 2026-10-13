import { describe, expect, it } from 'vite-plus/test'
import { clock, describeActive, describeFailure } from './runStatus'

const base = { id: 'r', status: 'running', at: 0, startedAt: 1000 } as const

describe('运行状态的展示', () => {
  it('按阶段说清在等谁', () => {
    expect(describeActive({ ...base, status: 'queued' }, 5000)).toMatchObject({ label: '排队中' })
    expect(
      describeActive({ ...base, phase: 'queued', via: '火山方舟 · Seedance' }, 43_000),
    ).toMatchObject({ label: '平台排队', detail: '火山方舟 · Seedance', step: 1, elapsed: 42_000 })
    expect(describeActive({ ...base, phase: 'generating', progress: 0.42 }, 2000)).toMatchObject({
      label: '生成中 42%',
      step: 2,
      progress: 0.42,
    })
    expect(describeActive({ ...base, phase: 'waiting', via: '百炼 · 万相' }, 2000).detail).toBe(
      '百炼并发已满，轮到就提交',
    )
  })

  it('等待重试时倒计时', () => {
    const run = { ...base, phase: 'retrying', retryAt: 10_000, message: '限流' } as const
    expect(describeActive(run, 6_500)).toMatchObject({
      label: '4 秒后重试',
      detail: '限流',
      retrying: true,
    })
    expect(describeActive(run, 11_000).label).toBe('正在重试')
  })

  it('失败按类别给人话和处理办法', () => {
    expect(describeFailure({ error: '火山方舟：API key 无效', errorCode: 'auth' })).toEqual({
      title: '密钥无效或没有权限',
      detail: '火山方舟：API key 无效',
      settings: true,
    })
    expect(describeFailure({ error: '参数不对', errorCode: 'invalid_input' })).toEqual({
      title: '参数不对',
      settings: false,
    })
  })

  it('时长等宽显示', () => {
    expect(clock(42_000)).toBe('0:42')
    expect(clock(725_000)).toBe('12:05')
    expect(clock(3_725_000)).toBe('1:02:05')
  })
})
