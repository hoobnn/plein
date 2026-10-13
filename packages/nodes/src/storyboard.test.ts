import { describe, expect, it } from 'vite-plus/test'
import {
  diffPlan,
  dropShot,
  matchLines,
  mergeShots,
  planParams,
  planVersion,
  type Shot,
  type ShotPlan,
  syncPlan,
} from './storyboard'

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

const withDialogue = (s: Shot, ...lines: [string, string][]): Shot => ({
  ...s,
  dialogue: lines.map(([character, line]) => ({ character, line })),
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

describe('展开时的计划快照', () => {
  it('版本号是内容哈希：表格改了就变，没改就不变', () => {
    const shots = [shot(1, '天台'), shot(2, '巷口')]
    const version = planVersion(shots)
    expect(version).toBe(planVersion([...shots]))
    expect(planVersion(shots)).not.toBe(planVersion([shot(1, '天台改'), shot(2, '巷口')]))
    // 键序不同（Yjs 往返）不该让版本乱跳
    const swapped = [{ ...shot(1, '天台'), motionPrompt: '' }, shot(2, '巷口')]
    expect(planVersion(swapped)).toBe(version)
  })

  it('每个角色只从分镜取自己那几个参数', () => {
    const s = withDialogue(
      { ...shot(1, '雨夜天台'), imagePrompt: '低机位', motionPrompt: '缓慢推近', duration: 7 },
      ['林夏', '你终于来了'],
      ['路人', '别过去'],
    )
    expect(planParams(s, 'image', { mentions: '@林夏' })).toEqual({
      prompt: '@林夏 低机位',
    })
    expect(planParams(s, 'video')).toEqual({ prompt: '缓慢推近', duration: 7 })
    // 音色连平台一起落进节点，展开出来的配音才受跨平台约束
    expect(
      planParams(s, 'speech', {
        line: 1,
        voice: { provider: 'doubao-speech', voiceId: 'v_linxia' },
      }),
    ).toEqual({
      text: '别过去',
      voice: { provider: 'doubao-speech', voiceId: 'v_linxia' },
    })
    // 旧画布里的裸字符串音色也能吃，平台标为未确认
    expect(planParams(s, 'speech', { line: 1, voice: 'v_linxia' })).toEqual({
      text: '别过去',
      voice: { provider: '', voiceId: 'v_linxia' },
    })
    // 没有分镜图提示词时退回画面描述；越界时长收敛到 1–30
    expect(planParams(shot(1, '雨夜天台'), 'image')).toEqual({ prompt: '雨夜天台' })
    expect(planParams({ ...shot(1, 'x'), duration: 99 }, 'video').duration).toBe(30)
  })
})

describe('节点与计划的差异', () => {
  const base = shot(1, '雨夜天台')
  const plan: ShotPlan = { version: 'v1', params: { prompt: '雨夜天台', duration: 5 }, keep: [] }

  it('分镜改了：提示词 stale；没改的字段不算差异', () => {
    const diffs = diffPlan('video', {
      plan,
      version: 'v2',
      wanted: planParams({ ...base, description: '雨夜天台，霓虹反光' }, 'video'),
      actual: { prompt: '雨夜天台', duration: 5 },
    })
    const prompt = diffs.find((d) => d.key === 'prompt')!
    expect(prompt.stale).toBe(true)
    expect(prompt.overridden).toBe(false)
    expect(prompt.wanted).toBe('雨夜天台，霓虹反光')
    expect(prompt.actual).toBe('雨夜天台')
    expect(diffs.find((d) => d.key === 'duration')!.stale).toBe(false)
  })

  it('用户在节点上手改：标 overridden，不再算成计划要同步的内容', () => {
    const diffs = diffPlan('video', {
      plan,
      version: 'v2',
      wanted: planParams({ ...base, duration: 8 }, 'video'),
      actual: { prompt: '我自己写的画面', duration: 5 },
    })
    expect(diffs.map((d) => [d.key, d.stale, d.overridden, d.legacy])).toEqual([
      ['prompt', false, true, false],
      ['duration', true, false, false],
    ])
  })

  it('接管的字段：计划再改也只提示，不算手改丢失', () => {
    const taken: ShotPlan = { version: 'v1', params: { prompt: '我自己写的' }, keep: ['prompt'] }
    const diffs = diffPlan('image', {
      plan: taken,
      version: 'v2',
      wanted: { prompt: '计划改的' },
      actual: { prompt: '我自己写的' },
    })
    expect([diffs[0]!.stale, diffs[0]!.overridden]).toEqual([true, true])
  })
})

describe('同步的两种选择', () => {
  const base = { ...shot(1, '雨夜天台'), duration: 8 }
  const plan: ShotPlan = { version: 'v1', params: { prompt: '雨夜天台', duration: 5 }, keep: [] }
  const wanted = planParams(base, 'video')
  const actual = { prompt: '我自己写的画面', duration: 5 }

  it('同步未改字段：只写用户没动过的，手改的保留', () => {
    const sync = syncPlan('video', 'unmodified', { plan, version: 'v2', wanted, actual })
    expect(sync.params).toEqual({ duration: 8 })
    // 快照里手改的值按节点现状记，并标成用户接管，之后不再被覆盖
    expect(sync.plan).toEqual({
      version: 'v2',
      params: { prompt: '我自己写的画面', duration: 8 },
      keep: ['prompt'],
    })
  })

  it('保留用户覆盖：一个字段都不写，节点现状固化成新基线', () => {
    const sync = syncPlan('video', 'keep-overrides', { plan, version: 'v2', wanted, actual })
    expect(sync.params).toEqual({})
    expect(sync.plan).toEqual({
      version: 'v2',
      params: { prompt: '我自己写的画面', duration: 5 },
      keep: ['prompt'],
    })
  })

  it('同步后再有差异：只剩手改那处，不会反复提示同一个字段', () => {
    const first = syncPlan('video', 'unmodified', { plan, version: 'v2', wanted, actual })
    const after: Record<string, unknown> = { ...actual, ...first.params }
    // 同一版里不再提示：手改被接管，未改的已经同步
    const again = diffPlan('video', {
      plan: first.plan,
      version: 'v2',
      wanted: planParams(base, 'video'),
      actual: after,
    })
    expect(again.some((d) => d.stale || d.overridden)).toBe(false)
    // 分镜再改一次：接管的字段也会重新提示，让用户看到计划又动了它
    const next = planParams({ ...base, description: '霓虹反光' }, 'video')
    const later = diffPlan('video', {
      plan: first.plan,
      version: 'v3',
      wanted: next,
      actual: after,
    })
    expect(later.filter((d) => d.stale).map((d) => d.key)).toEqual(['prompt'])
  })

  it('没有快照的老节点：缺失字段不当成手改，按计划补上', () => {
    const sync = syncPlan('speech', 'unmodified', {
      version: 'v1',
      wanted: { text: '台词', voice: '' },
      actual: {},
    })
    expect(sync.params).toEqual({ text: '台词' })
    expect(sync.plan.params).toEqual({ text: '台词', voice: '' })
    expect(sync.plan.keep).toEqual([])
  })

  it('用户改过的字段记进 keep：之后的同步不会再覆盖它', () => {
    const first = syncPlan('video', 'unmodified', { plan, version: 'v2', wanted, actual })
    expect(first.plan.keep).toEqual(['prompt'])
    // 计划第三次改动，手改的提示词照样不被覆盖
    const next = syncPlan('video', 'unmodified', {
      plan: first.plan,
      version: 'v3',
      wanted: planParams({ ...base, description: '霓虹反光' }, 'video'),
      actual: { ...actual, ...first.params },
    })
    expect(next.params).toEqual({})
    expect(next.plan.params.prompt).toBe('我自己写的画面')
    expect(next.plan.keep).toEqual(['prompt'])
  })
})

describe('删除镜头', () => {
  it('只从计划里去掉这一行，并把它报出来给调用方提示保留的节点', () => {
    const shots = [shot(1, '天台'), shot(2, '巷口'), shot(3, '桥上')]
    const { shots: left, dropped } = dropShot(shots, 's2')
    expect(left.map((s) => s.id)).toEqual(['s1', 's3'])
    expect(dropped?.no).toBe(2)
    // 删不存在的镜头：表格原样返回，不误删
    expect(dropShot(shots, 'nope').shots).toBe(shots)
  })
})

describe('配音节点按内容对应台词', () => {
  const lines = (...texts: string[]) => texts.map((line) => ({ character: '林夏', line }))
  const spoken = [
    { id: 'a', line: 0, text: '第一句' },
    { id: 'b', line: 1, text: '第二句' },
    { id: 'c', line: 2, text: '第三句' },
  ]
  const match = (dialogue: ReturnType<typeof lines>) =>
    Object.fromEntries(matchLines(spoken, dialogue))

  it('删掉中间一句：后面的节点跟着内容走，被删的那句对不上', () => {
    expect(match(lines('第一句', '第三句'))).toEqual({ a: 0, b: undefined, c: 1 })
  })

  it('开头插一句：已有节点整体后移，新台词留给补节点', () => {
    expect(match(lines('新的一句', '第一句', '第二句', '第三句'))).toEqual({ a: 1, b: 2, c: 3 })
  })

  it('原地改字：内容对不上时按原序号对应', () => {
    expect(match(lines('第一句', '改过的第二句', '第三句'))).toEqual({ a: 0, b: 1, c: 2 })
  })

  it('同文多句：各取离原序号最近的一句，不重复认领', () => {
    const same = [
      { id: 'x', line: 0, text: '好' },
      { id: 'y', line: 2, text: '好' },
    ]
    const got = matchLines(same, lines('好', '嗯', '好'))
    expect(Object.fromEntries(got)).toEqual({ x: 0, y: 2 })
  })

  it('改成空行：当作删除', () => {
    expect(match(lines('第一句', '', '第三句'))).toEqual({ a: 0, b: undefined, c: 2 })
  })
})
