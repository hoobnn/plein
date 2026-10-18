import { describe, expect, it } from 'vite-plus/test'
import { findMentions } from './mentions'
import {
  type CharacterProfile,
  matchProfile,
  nameProblem,
  pickImages,
  pickLabel,
  pickNotes,
  pickVoice,
  profileOf,
  profileOptions,
  renamed,
} from './profile'

const img = (c: string) => c.repeat(64)
const look = (
  id: string,
  name: string,
  extra: Partial<{ description: string; images: string[]; aliases: string[] }> = {},
) => ({
  id,
  name,
  aliases: [],
  description: '',
  images: [],
  ...extra,
})

const profile: CharacterProfile = profileOf({
  periods: [
    {
      ...look('p1', '少年', {
        description: '十五岁，扎马尾',
        images: [img('1'), img('2'), img('3')],
      }),
      voice: { provider: 'doubao/speech', voiceId: 'young' },
      voiceStates: [
        {
          id: 'v1',
          name: '生病',
          aliases: [],
          voice: { provider: 'doubao/speech', voiceId: 'sick' },
        },
      ],
      outfits: [look('o1', '校服', { description: '蓝白校服', images: [img('4')] })],
    },
    {
      ...look('p2', '青年', { description: '二十五岁，短发' }),
      voice: null,
      voiceStates: [],
      outfits: [look('o2', '正装', { aliases: ['西装'] })],
    },
  ],
  expressions: [look('e1', '开心', { images: [img('5')] }), look('e2', '开心大笑')],
})

describe('角色档案', () => {
  it('按 / 解析时期、服饰、表情，长名字优先，顺序随意', () => {
    const m = matchProfile('/开心大笑/少年/校服站在天台', profile)
    expect(m.pick.period?.id).toBe('p1')
    expect(m.pick.outfit?.id).toBe('o1')
    expect(m.pick.expression?.id).toBe('e2')
    expect(m.length).toBe('/开心大笑/少年/校服'.length)
  })

  it('只写服饰或次音色时时期取它所属的那个；旧名照样认', () => {
    expect(matchProfile('/西装', profile).pick.period?.id).toBe('p2')
    expect(matchProfile('/生病', profile).pick.period?.id).toBe('p1')
  })

  it('服饰不属于写明的时期时丢掉服饰并说明', () => {
    const m = matchProfile('/少年/正装', profile)
    expect(m.pick.outfit).toBeUndefined()
    expect(m.conflict).toContain('青年')
  })

  it('对不上的档案项留在文本里并报出来', () => {
    const m = matchProfile('/学生装', profile)
    expect(m.length).toBe(0)
    expect(m.miss).toBe('学生装')
  })

  it('设定、参考图和音色按 时期 → 服饰 → 表情 叠加', () => {
    const { pick } = matchProfile('/少年/校服/开心/生病', profile)
    expect(pickLabel('林夏', pick)).toBe('林夏（少年·校服·开心·生病）')
    expect(pickNotes('黑长直', pick).split('\n')).toEqual([
      '黑长直',
      '少年时期：十五岁，扎马尾',
      '服饰「校服」：蓝白校服',
      '表情「开心」',
    ])
    expect(pickImages(pick, [img('9'), img('1')])).toEqual([
      img('1'),
      img('2'),
      img('4'),
      img('5'),
      img('9'),
    ])
    expect(pickVoice(pick, { provider: '', voiceId: 'base' }).voiceId).toBe('sick')
    expect(
      pickVoice(matchProfile('/少年', profile).pick, { provider: '', voiceId: 'base' }).voiceId,
    ).toBe('young')
    expect(
      pickVoice(matchProfile('/青年', profile).pick, { provider: '', voiceId: 'base' }).voiceId,
    ).toBe('base')
  })

  it('改名保留旧名，重名不让用', () => {
    const r = renamed(look('x', '日常'), '居家')
    expect(r).toMatchObject({ name: '居家', aliases: ['日常'] })
    expect(renamed(r, '日常')).toMatchObject({ name: '日常', aliases: ['居家'] })
    expect(nameProblem(profile, '西装')).toContain('用过')
    expect(nameProblem(profile, '正装', 'o2')).toBeUndefined()
    expect(nameProblem(profile, 'a/b')).toBeDefined()
  })

  it('连续改名超过八次仍保留最近旧名及引用，优先淘汰最早旧名', () => {
    let current = look('recent', '最初', { images: [img('f')], description: '蓝色造型' })
    for (let i = 1; i <= 9; i++) current = renamed(current, `名字${i}`)
    expect(current.aliases).toEqual([
      '名字8',
      '名字7',
      '名字6',
      '名字5',
      '名字4',
      '名字3',
      '名字2',
      '名字1',
    ])
    const recent = { ...profile, expressions: [current] }
    expect(matchProfile('/名字8', recent).pick.expression?.id).toBe('recent')
    expect(pickImages(matchProfile('/名字8', recent).pick, [])).toEqual([img('f')])
    expect(matchProfile('/最初', recent).pick.expression).toBeUndefined()
    const restored = renamed(current, '名字8')
    expect(restored.aliases[0]).toBe('名字9')
    expect(restored.aliases).not.toContain('名字8')
  })

  it('补全只给还没写的那一类，服饰限定在写明的时期', () => {
    const { pick } = matchProfile('/青年', profile)
    const opts = profileOptions(profile, pick)
    expect(opts.some((o) => o.slot === 'period')).toBe(false)
    expect(opts.filter((o) => o.slot === 'outfit').map((o) => o.name)).toEqual(['正装'])
  })

  it('@ 引用带上档案项，没有档案的目标不受影响', () => {
    const m = findMentions('@林夏/少年/校服站着，@天台/少年', [
      { id: 'a', name: '林夏', profile },
      { id: 'c', name: '天台' },
    ])
    expect(m[0]).toMatchObject({ id: 'a', end: '@林夏/少年/校服'.length })
    expect(m[0]!.pick?.outfit?.name).toBe('校服')
    expect(m[1]!.pick).toBeUndefined()
  })

  it('格式不对的档案当作空', () => {
    expect(profileOf({ periods: 'x' })).toEqual({ periods: [], expressions: [] })
  })
})
