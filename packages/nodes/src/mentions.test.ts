import { describe, expect, it } from 'vite-plus/test'
import {
  findBrokenMentions,
  findMentions,
  type MentionTarget,
  mentionName,
  mentionProblem,
  mentionQuery,
} from './mentions'

describe('@ 引用', () => {
  it('邮箱和转义的 @ 不触发素材引用、断链提示或补全，中文相邻引用仍生效', () => {
    const targets = [
      { id: 'domain', name: 'example.com' },
      { id: 'role', name: '林夏' },
    ]
    const literal = '联系 test@example.com；说明 \\@林夏 和 @@林夏'
    expect(findMentions(literal, targets)).toEqual([])
    expect(findBrokenMentions('test@林旧名 \\@林旧名 @@林旧名', targets)).toEqual([])
    for (const text of ['test@exam', '\\@林', '@@林'])
      expect(mentionQuery(text, text.length, targets)).toBeNull()
    expect(findMentions('看着@林夏，\\\\@林夏', targets).map((m) => m.id)).toEqual(['role', 'role'])
  })
  it('含空格的角色名可以继续补全档案，正文空白不延长查询', () => {
    const spaced = [{ id: 'a', name: '小岚 · 引用' }]
    expect(mentionQuery('@小岚 · 引用/少', 10, spaced)?.query).toBe('小岚 · 引用/少')
    expect(mentionQuery('@小岚 · 引用 走来', 11, spaced)).toBeNull()
    expect(
      findMentions('@小岚/不存在', [
        { id: 'a', name: '小岚', profile: { periods: [], expressions: [] } },
      ])[0]?.profileMiss,
    ).toBe('不存在')
  })
  const targets: MentionTarget[] = [
    { id: 'a', name: '林夏' },
    { id: 'b', name: '林夏夏' },
    { id: 'c', name: '天台' },
  ]

  it('中文无空格时取最长匹配的名字', () => {
    const m = findMentions('@林夏夏站在@天台上，@路人 看着', targets)
    expect(m.map((x) => [x.name, x.id])).toEqual([
      ['林夏夏', 'b'],
      ['天台', 'c'],
    ])
    expect(m[1]).toMatchObject({ start: 6, end: 9 })
  })

  it('光标前正在输入的 @ 查询', () => {
    expect(mentionQuery('一个 @林', 5)).toMatchObject({ start: 3, query: '林' })
    expect(mentionQuery('一个 @林夏 走来', 9)).toBeNull()
    expect(mentionQuery('没有引用', 4)).toBeNull()
  })

  it('输入时给出候选，写法带 #序号', () => {
    const dup: MentionTarget[] = [...targets, { id: 'd', name: '林夏' }]
    const q = mentionQuery('画 @林', 4, dup)!
    expect(q.candidates).toEqual([
      { name: '林夏', insert: '林夏#1', total: 2 },
      { name: '林夏', insert: '林夏#2', total: 2 },
      { name: '林夏夏', insert: '林夏夏', total: 1 },
    ])
  })
})

describe('重名消歧', () => {
  const dup: MentionTarget[] = [
    { id: 'a', name: '林夏' },
    { id: 'b', name: '天台' },
    { id: 'c', name: '林夏' },
  ]

  it('单名写法命中重名时不猜第一个，给出可照抄的写法', () => {
    const [m] = findMentions('@林夏走过来', dup)
    expect(m).toMatchObject({ name: '林夏', id: undefined, total: 2, ids: ['a', 'c'] })
    expect(mentionProblem(m!)).toBe('画布上有 2 个「林夏」，请写成 @林夏#1 或 @林夏#2')
  })

  it('#序号 命中对应的那个资产', () => {
    const m = findMentions('@林夏#2走过来', dup)
    expect(m[0]).toMatchObject({ name: '林夏', id: 'c', index: 2 })
    expect(m[0]!.end).toBe(5)
    expect(mentionProblem(m[0]!)).toBeUndefined()
  })

  it('序号越界说清楚画布上到底有哪几个', () => {
    const [m] = findMentions('@林夏#3', dup)
    expect(mentionProblem(m!)).toBe('「@林夏#3」不存在，画布上「林夏」只有 @林夏#1、@林夏#2')
  })
})

describe('改名断链', () => {
  const renamed: MentionTarget[] = [
    { id: 'a', name: '林小夏' },
    { id: 'b', name: '天台' },
  ]

  it('引用了不存在的名字时给出像的候选', () => {
    // 中文没有词边界，@后面一串都算名字；首字不同的候选不报，避免噪音
    const broken = findBrokenMentions('@林夏站在天台', renamed)
    expect(broken).toHaveLength(1)
    expect(broken[0]).toMatchObject({ name: '林夏站在天台', candidates: ['林小夏'] })
  })

  it('像邮箱、@所有人 这类没有相近候选的写法不打扰用户', () => {
    expect(findBrokenMentions('联系 @someone 就行', renamed)).toEqual([])
    expect(findBrokenMentions('@所有人 到场', renamed)).toEqual([])
  })

  it('引用还对得上时不算断链', () => {
    expect(findBrokenMentions('@林小夏站在@天台', renamed)).toEqual([])
  })
})

describe('能被 @ 引用的元素', () => {
  it.each([
    [{ kind: 'node', nodeType: 'plein/character', name: ' 林夏 ' }, '林夏'],
    [{ kind: 'node', nodeType: 'plein/effect', name: '雨' }, '雨'],
    [{ kind: 'image', assetId: 'a', name: '海报' }, '海报'],
    [{ kind: 'image', name: '还没上传' }, null],
    [{ kind: 'node', nodeType: 'plein/image', name: '生成图片' }, null],
    [{ kind: 'node', nodeType: 'plein/character', name: '  ' }, null],
  ])('%o → %s', (el, name) => {
    expect(mentionName(el)).toBe(name)
  })
})
