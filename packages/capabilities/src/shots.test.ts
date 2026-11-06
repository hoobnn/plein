import { createElement, setParams } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { corePlugin, type Shot } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { updateElementCap } from './canvas'
import type { CapabilityContext } from './define'
import { editShots, getShots } from './shots'
import { nodeElementOf } from './story/nodes'
import {
  expandShots,
  expandedNodes,
  planDiffs,
  shotsOf,
  syncExpanded,
  type ShotSource,
} from './story/storyboard'

const make = (type: string) => {
  const def = corePlugin.nodes?.find((def) => def.type === type)
  return def && nodeElementOf(describeNode(def, 'plein/core'))
}
const docs: ReturnType<typeof openDoc>[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))

const shot = (no: number, extra: Partial<Shot> = {}): Shot => ({
  id: `shot_${no}`,
  no,
  duration: 5,
  shotSize: '中景',
  description: `第 ${no} 镜`,
  characters: [],
  emotion: '',
  lighting: '',
  sfx: '',
  dialogue: [],
  imagePrompt: '',
  motionPrompt: '',
  ...extra,
})

function fixture(shots: Shot[] = [shot(1), shot(2), shot(3)]) {
  const doc = openDoc()
  docs.push(doc)
  const board = createElement(doc, {
    ...make('plein/storyboard')!,
    x: 0,
    y: 0,
    params: { shots },
  })
  const ctx = {
    canvasId: 'c',
    withDoc: (fn: (d: typeof doc) => unknown) => fn(doc),
    nodes: { latest: () => undefined },
    assetMeta: () => undefined,
  } as unknown as CapabilityContext
  const read = () =>
    getShots.run(ctx, getShots.input.parse({ id: board })) as { version: string; shots: Shot[] }
  const edit = (ops: unknown[], version = read().version) =>
    editShots.run(ctx, editShots.input.parse({ id: board, expected_version: version, ops })) as {
      version: string
      total: number
      detached_nodes?: number
    }
  return { doc, board, ctx, read, edit }
}

describe('逐镜修改分镜表', () => {
  it('add / patch / move / remove 按编辑器语义生效，一次撤销，版本凭据防覆盖', () => {
    const f = fixture()
    const v0 = f.read().version
    f.edit([
      { op: 'patch', shot_id: 'shot_2', fields: { description: '改过', duration: 8 } },
      { op: 'add', shot: { description: '新镜头', sfx: '风声' } },
    ])
    const after = f.read().shots
    expect(after.map((s) => s.no)).toEqual([1, 2, 3, 4])
    expect(after[1]).toMatchObject({ description: '改过', duration: 8, edited: true })
    expect(after[0]!.edited).toBeUndefined()
    expect(after[3]).toMatchObject({ description: '新镜头', sfx: '风声', edited: true })
    // 旧版本不能再写
    expect(() => f.edit([{ op: 'remove', shot_id: 'shot_1' }], v0)).toThrow('重新 get_shots')

    f.edit([{ op: 'move', shot_id: 'shot_3', to: 0 }])
    expect(f.read().shots.map((s) => [s.id, s.no])).toEqual([
      ['shot_3', 1],
      ['shot_1', 2],
      ['shot_2', 3],
      [after[3]!.id, 4],
    ])
    const removed = f.edit([{ op: 'remove', shot_id: 'shot_1' }])
    expect(removed.total).toBe(3)
    expect(() => f.edit([{ op: 'patch', shot_id: 'nope', fields: { sfx: 'x' } }])).toThrow(
      'get_shots',
    )
    // 失败的 ops 不留下部分修改
    const before = f.read().version
    expect(() =>
      f.edit([
        { op: 'patch', shot_id: 'shot_2', fields: { sfx: 'x' } },
        { op: 'remove', shot_id: 'missing' },
      ]),
    ).toThrow()
    expect(f.read().version).toBe(before)
    // 一次调用一步撤销
    f.doc.undo.undo()
    expect(f.read().shots).toHaveLength(4)
  })

  it('台词替换沿用原台词身份，字段校验拒绝越界值', () => {
    const f = fixture([shot(1, { dialogue: [{ id: 'd1', character: '甲', line: '你好' }] })])
    f.edit([
      {
        op: 'patch',
        shot_id: 'shot_1',
        fields: {
          dialogue: [
            { character: '甲', line: '你好' },
            { character: '乙', line: '再见' },
          ],
        },
      },
    ])
    const lines = f.read().shots[0]!.dialogue
    expect(lines[0]!.id).toBe('d1')
    expect(lines[1]!.id).toBeTruthy()
    expect(() =>
      editShots.input.parse({
        id: f.board,
        expected_version: 'x',
        ops: [{ op: 'patch', shot_id: 'shot_1', fields: { duration: 99 } }],
      }),
    ).toThrow()
    expect(() =>
      editShots.input.parse({
        id: f.board,
        expected_version: 'x',
        ops: [{ op: 'patch', shot_id: 'shot_1', fields: { no: 9 } }],
      }),
    ).toThrow()
  })

  it('保持计划基线：编辑后 sync_storyboard 区分「计划变了」与「节点被手改」，删镜头标记脱离计划', () => {
    const run = (viaTool: boolean) => {
      const f = fixture([
        shot(1, { sfx: '夜间环境声', dialogue: [{ id: 'd1', character: '', line: '你好' }] }),
      ])
      expandShots(f.doc, f.board, ['shot_1'], make)
      const nodes = () => expandedNodes(f.doc, f.board).get('shot_1') ?? []
      // 模拟升级前的快照：没有逐字段计划基线
      for (const n of nodes()) {
        const source = n.params?.source as ShotSource
        const { accepted: _a, ...plan } = source.plan!
        setParams(f.doc, n.id, { source: { ...source, plan } })
      }
      const video = nodes().find((n) => (n.params!.source as ShotSource).role === 'video')!
      setParams(f.doc, video.id, { prompt: '用户定制视频提示词' })
      if (viaTool) f.edit([{ op: 'patch', shot_id: 'shot_1', fields: { description: '新画面' } }])
      else {
        const only = shotsOf(f.doc.get(f.board))[0]!
        updateElementCap.run(f.ctx, {
          id: f.board,
          params: { shots: [{ ...only, description: '新画面' }] },
        } as never)
      }
      const diffs = planDiffs(f.doc, f.board).get('shot_1') ?? []
      return { f, diffs, video, nodes }
    }
    for (const viaTool of [true, false]) {
      const { f, diffs, video } = run(viaTool)
      // 画面变了：图片与视频节点按「计划变了」报差异；视频提示词用户改过，标为 overridden
      const videoDiff = diffs.find((d) => d.el.id === video.id)!
      expect(videoDiff.diffs.some((d) => d.stale && d.overridden)).toBe(true)
      const image = diffs.find((d) => (d.el.params!.source as ShotSource).role === 'image')!
      expect(image.diffs.every((d) => d.stale && !d.overridden)).toBe(true)
      // 基线已补记：旧快照节点都有 accepted
      for (const d of diffs) expect((d.el.params!.source as ShotSource).plan?.accepted).toBeTruthy()
      syncExpanded(f.doc, f.board, ['shot_1'], 'unmodified')
      expect(f.doc.get(video.id)!.params!.prompt).toBe('用户定制视频提示词')
    }
    const { f, nodes } = run(true)
    const gone = f.edit([{ op: 'remove', shot_id: 'shot_1' }])
    expect(gone.detached_nodes).toBe(nodes().length)
    expect(nodes().every((n) => (n.params!.source as ShotSource).detached)).toBe(true)
    f.doc.undo.undo()
    expect(nodes().every((n) => !(n.params!.source as ShotSource).detached)).toBe(true)
  })

  it('有格式不对的行时拒绝写入，不丢行', () => {
    const f = fixture()
    setParams(f.doc, f.board, { shots: [shot(1), { id: 'bad', no: 'x' } as never] })
    expect(() => f.edit([{ op: 'add' }], 'any')).toThrow('格式不对')
  })
})
