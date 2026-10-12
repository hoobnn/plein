import { describe, expect, it } from 'vitest'
import { hasVoice, noVoice, voiceFitsProvider, voiceOf } from './refs'

describe('音色引用', () => {
  it.each([
    ['旧版裸字符串按未指定平台处理', { voice: ' S_1 ' }, { provider: '', voiceId: 'S_1' }],
    [
      '新版引用原样读出',
      { voice: { provider: 'a/b', voiceId: 'v' } },
      { provider: 'a/b', voiceId: 'v' },
    ],
    ['缺字段补空串', { voice: { voiceId: 'v' } }, { provider: '', voiceId: 'v' }],
    ['没有音色', {}, noVoice],
    ['参数为空', null, noVoice],
    ['类型不对', { voice: 42 }, noVoice],
  ])('voiceOf：%s', (_, params, voice) => {
    expect(voiceOf(params)).toEqual(voice)
  })

  it('只有空白的 voiceId 不算选中', () => {
    expect(hasVoice({ provider: 'a/b', voiceId: '  ' })).toBe(false)
    expect(hasVoice({ provider: '', voiceId: 'v' })).toBe(true)
    expect(hasVoice(null)).toBe(false)
  })

  it.each([
    ['同一平台', { provider: 'a/b', voiceId: 'v' }, 'a/b', true],
    ['别的平台', { provider: 'a/b', voiceId: 'v' }, 'c/d', false],
    ['音色未指定平台', { provider: '', voiceId: 'v' }, 'a/b', false],
    ['目标平台为空', { provider: 'a/b', voiceId: 'v' }, '', false],
    ['没选音色', { provider: 'a/b', voiceId: '' }, 'a/b', false],
  ])('voiceFitsProvider：%s', (_, voice, provider, ok) => {
    expect(voiceFitsProvider(voice, provider)).toBe(ok)
  })
})
