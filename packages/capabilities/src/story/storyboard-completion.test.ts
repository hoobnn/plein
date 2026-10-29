import { createElement, deleteElements, setParams, updateElement } from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { corePlugin, type Shot } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import { nodeElementOf } from './nodes'
import {
  expandShots,
  expandedNodes,
  planDiffs,
  runExpanded,
  shotsOf,
  syncExpanded,
  writeStoryboardShots,
  type ShotSource,
} from './storyboard'

const make = (type: string) => {
  const def = corePlugin.nodes?.find((def) => def.type === type)
  return def && nodeElementOf(describeNode(def, 'plein/core'))
}
const fixture = (extra: Partial<Shot> = {}) => {
  const doc = openDoc()
  const shot: Shot = {
    id: 'shot_one',
    no: 1,
    duration: 5,
    shotSize: '中景',
    description: '天台',
    characters: [],
    emotion: '',
    lighting: '',
    sfx: '',
    dialogue: [],
    imagePrompt: '',
    motionPrompt: '',
    ...extra,
  }
  const board = createElement(doc, {
    ...make('plein/storyboard')!,
    x: 0,
    y: 0,
    params: { shots: [shot] },
  })
  const seq = createElement(doc, { ...make('plein/sequence')!, x: 600, y: 0 })
  const expanded = () => expandedNodes(doc, board).get(shot.id) ?? []
  const role = (name: string) =>
    expanded().find((el) => (el.params!.source as ShotSource).role === name)!
  const write = (next: Partial<Shot>) =>
    setParams(doc, board, { shots: [{ ...shotsOf(doc.get(board))[0]!, ...next }] })
  return { doc, shot, board, seq, expanded, role, write }
}

describe('分镜创作闭环', () => {
  it('旧快照确认后仅修改音效，不重报其他已确认的手改字段', () => {
    const f = fixture({ sfx: '夜间环境声', dialogue: [{ id: 'd1', character: '', line: '你好' }] })
    try {
      expandShots(f.doc, f.board, [f.shot.id], make)
      setParams(f.doc, f.role('video').id, { prompt: '用户定制视频提示词' })
      f.write({ description: '更新的画面' })
      syncExpanded(f.doc, f.board, [f.shot.id], 'keep-overrides')
      // 模拟升级前已经确认但没有逐字段计划基线的快照。
      for (const node of f.expanded()) {
        const source = node.params?.source as ShotSource | undefined
        if (!source?.plan) continue
        const { accepted: _accepted, ...oldPlan } = source.plan
        setParams(f.doc, node.id, { source: { ...source, plan: oldPlan } })
      }
      expect(planDiffs(f.doc, f.board).size).toBe(0)
      const shot = shotsOf(f.doc.get(f.board))[0]!
      writeStoryboardShots(f.doc, f.board, [{ ...shot, sfx: '新增翻页声' }])
      const diffs = [...planDiffs(f.doc, f.board).values()].flat()
      expect(diffs.map((item) => item.role)).toEqual(['sfx'])
      expect(diffs[0]!.diffs[0]).toMatchObject({ key: 'prompt', stale: true })
      expect(f.role('video').params?.prompt).toBe('用户定制视频提示词')
    } finally {
      f.doc.destroy()
    }
  })
  it('景别、光影、情绪进入实际参数；语气同步保留用户覆盖', () => {
    const f = fixture({
      shotSize: '特写',
      lighting: '窗边逆光',
      emotion: '低声悲伤',
      dialogue: [{ id: 'd1', character: '', line: '再见' }],
    })
    expandShots(f.doc, f.board, [f.shot.id], make)
    expect(f.role('image').params?.prompt).toBe('天台 景别：特写；光影：窗边逆光；情绪：低声悲伤')
    expect(f.role('video').params?.prompt).toContain('景别：特写；光影：窗边逆光；情绪：低声悲伤')
    expect(f.role('speech').params?.instruction).toBe('低声悲伤')
    setParams(f.doc, f.role('speech').id, { instruction: '用户的哭腔' })
    f.write({ lighting: '冷光', emotion: '坚定' })
    expect(
      planDiffs(f.doc, f.board)
        .get(f.shot.id)
        ?.find((d) => d.role === 'speech')?.diffs,
    ).toContainEqual(expect.objectContaining({ key: 'instruction', stale: true, overridden: true }))
    syncExpanded(f.doc, f.board, [f.shot.id], 'unmodified')
    expect(f.role('image').params?.prompt).toContain('光影：冷光；情绪：坚定')
    expect(f.role('speech').params?.instruction).toBe('用户的哭腔')
    f.doc.destroy()
  })

  it('显式绑定消歧，同名卡和改名不改变说话人的对象；绑定删除不误选同名卡', () => {
    const f = fixture()
    const a = createElement(
      f.doc,
      node({
        nodeType: 'plein/character',
        name: '林夏',
        params: { voice: { provider: 'p', voiceId: 'a' } },
      }),
    )
    const b = createElement(
      f.doc,
      node({
        nodeType: 'plein/character',
        name: '林夏',
        params: { voice: { provider: 'p', voiceId: 'b' } },
      }),
    )
    f.write({
      characters: ['林夏'],
      assetBindings: { 林夏: { elementId: b } },
      dialogue: [{ id: 'd1', character: '林夏', line: '好', speaker: { elementId: b } }],
    })
    expect(expandShots(f.doc, f.board, [f.shot.id], make).ambiguous).toEqual([])
    expect(f.role('speech').params?.voice).toEqual({ provider: 'p', voiceId: 'b' })
    expect(f.role('image').params?.prompt).toMatch(/@林夏#[12]/)
    updateElement(f.doc, b, { name: '林小夏' })
    syncExpanded(f.doc, f.board, [f.shot.id], 'unmodified')
    expect(f.role('image').params?.prompt).toContain('@林小夏')
    expect(f.role('speech').params?.voice).toEqual({ provider: 'p', voiceId: 'b' })
    deleteElements(f.doc, [b])
    syncExpanded(f.doc, f.board, [f.shot.id], 'unmodified')
    expect(f.role('speech').params?.voice).not.toEqual({ provider: 'p', voiceId: 'a' })
    expect(f.doc.get(a)).toBeDefined()
    f.doc.destroy()
  })

  it('同文多说话人重排、删句并改相邻句只按 dialogue id 对应，删除素材保留但退出序列', () => {
    const f = fixture({
      dialogue: [
        { id: 'a', character: '甲', line: '好' },
        { id: 'b', character: '乙', line: '好' },
        { id: 'c', character: '丙', line: '第三句' },
      ],
    })
    expandShots(f.doc, f.board, [f.shot.id], make)
    const speech = f.expanded().filter((el) => (el.params!.source as ShotSource).role === 'speech')
    const a = speech.find((el) => (el.params!.source as ShotSource).dialogueId === 'a')!
    const b = speech.find((el) => (el.params!.source as ShotSource).dialogueId === 'b')!
    const c = speech.find((el) => (el.params!.source as ShotSource).dialogueId === 'c')!
    f.write({
      dialogue: [
        { id: 'c', character: '丙', line: '改过的第三句' },
        { id: 'a', character: '甲', line: '好' },
      ],
    })
    syncExpanded(f.doc, f.board, [f.shot.id], 'unmodified')
    expandShots(f.doc, f.board, [f.shot.id], make, { mode: 'update' })
    expect(f.doc.get(a.id)?.params?.text).toBe('好')
    expect(f.doc.get(c.id)?.params?.text).toBe('改过的第三句')
    expect(f.doc.get(b.id)?.params?.text).toBe('好')
    expect(
      (f.doc.get(f.seq)!.params!.clips as Array<{ dialogue: string; more?: string[] }>)[0],
    ).toMatchObject({ dialogue: c.id, more: [a.id] })
    f.doc.destroy()
  })

  it('镜头音效展开、单独批量运行、接入所属镜头；清空后保留旧节点但不再播放', () => {
    const f = fixture({ sfx: '远处雷声' })
    expect(expandShots(f.doc, f.board, [f.shot.id], make).created).toBe(3)
    const sfx = f.role('sfx')
    expect(sfx.params).toMatchObject({ prompt: '远处雷声', duration: 5 })
    expect(
      [...f.doc.edges()].some(
        (edge) => edge.from[0] === sfx.id && edge.to[0] === f.seq && edge.to[1] === 'sfx',
      ),
    ).toBe(true)
    expect((f.doc.get(f.seq)!.params!.clips as Array<{ sfx?: string }>)[0]?.sfx).toBe(sfx.id)
    const runs: string[] = []
    expect(runExpanded(f.doc, f.board, [f.shot.id], 'sfx', (id) => runs.push(id)).started).toBe(1)
    expect(runs).toEqual([sfx.id])
    f.write({ sfx: '' })
    syncExpanded(f.doc, f.board, [f.shot.id], 'unmodified')
    expandShots(f.doc, f.board, [f.shot.id], make, { mode: 'update' })
    expect((f.doc.get(f.seq)!.params!.clips as Array<{ sfx?: string }>)[0]?.sfx).toBe('')
    expect(f.doc.get(sfx.id)).toBeDefined()
    f.doc.destroy()
  })
})
