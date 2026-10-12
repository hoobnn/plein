import { describe, expect, it } from 'vitest'
import { FlowGraph, runDag, stableStringify, type StepOutcome, topoLayers } from './index'

const e = (a: string, b: string) => ({ from: [a, 'out'] as const, to: [b, 'in'] as const })

describe('FlowGraph', () => {
  it('上下游与经过中间元素的依赖', () => {
    // a → t(纯文本) → b → c，d 独立
    const g = new FlowGraph([e('a', 't'), e('t', 'b'), e('b', 'c')])
    expect([...g.ancestors('c')].sort()).toEqual(['a', 'b', 't'])
    expect([...g.descendants('a')].sort()).toEqual(['b', 'c', 't'])
    const deps = g.dependencies(['a', 'b', 'c', 'd'])
    expect([...deps.get('b')!]).toEqual(['a'])
    // c 只直接依赖最近的目标 b
    expect([...deps.get('c')!]).toEqual(['b'])
    expect(deps.get('d')!.size).toBe(0)
  })

  it('分层与成环检测', () => {
    const g = new FlowGraph([
      e('a', 'b'),
      e('a', 'c'),
      e('b', 'd'),
      e('c', 'd'),
      e('x', 'y'),
      e('y', 'x'),
    ])
    const { layers, cycle } = topoLayers(g.dependencies(['a', 'b', 'c', 'd', 'x', 'y']))
    expect(layers.map((l) => l.sort())).toEqual([['a'], ['b', 'c'], ['d']])
    expect(cycle.sort()).toEqual(['x', 'y'])
  })
})

describe('runDag', () => {
  it('按依赖顺序运行，互不依赖的并发；失败的下游跳过', async () => {
    const g = new FlowGraph([e('a', 'b'), e('a', 'c'), e('c', 'd'), e('x', 'y'), e('y', 'x')])
    const order: string[] = []
    let concurrent = 0
    let peak = 0
    const outcome: Record<string, StepOutcome> = { a: 'cached', b: 'succeeded', c: 'failed' }
    const r = await runDag(g.dependencies(['a', 'b', 'c', 'd', 'x', 'y']), async (id) => {
      concurrent++
      peak = Math.max(peak, concurrent)
      order.push(id)
      await new Promise((res) => setTimeout(res, 10))
      concurrent--
      return outcome[id] ?? 'succeeded'
    })
    expect(order[0]).toBe('a')
    expect(peak).toBe(2)
    expect(r.cached).toEqual(['a'])
    expect(r.succeeded).toEqual(['b'])
    expect(r.failed).toEqual(['c'])
    expect(r.skipped.sort()).toEqual(['d', 'x', 'y'])
  })

  it('中止后不再开始新的节点', async () => {
    const ctrl = new AbortController()
    const g = new FlowGraph([e('a', 'b')])
    const r = await runDag(
      g.dependencies(['a', 'b']),
      async () => {
        ctrl.abort()
        return 'canceled'
      },
      { signal: ctrl.signal },
    )
    expect(r.canceled).toEqual(['a'])
    expect(r.skipped).toEqual(['b'])
  })
})

describe('stableStringify', () => {
  it('与键顺序无关', () => {
    expect(stableStringify({ b: 1, a: [{ y: 2, x: undefined, z: null }] })).toBe(
      stableStringify({ a: [{ z: null, y: 2 }], b: 1 }),
    )
  })
})
