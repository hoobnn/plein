import { describe, expect, it } from 'vite-plus/test'
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

  it('忽略自连边', () => {
    const g = new FlowGraph([e('a', 'a'), e('a', 'b')])
    expect(g.upstream('a').size).toBe(0)
    expect([...g.descendants('a')]).toEqual(['b'])
  })

  it('分层时忽略目标集合之外的依赖', () => {
    const deps = new Map([
      ['a', new Set(['outside'])],
      ['b', new Set(['a'])],
    ])
    expect(topoLayers(deps)).toEqual({ layers: [['a'], ['b']], cycle: [] })
  })

  it('每层保留目标顺序，环及其下游都不进入可执行层', () => {
    const deps = new Map([
      ['d', new Set(['b'])],
      ['c', new Set(['a'])],
      ['a', new Set<string>()],
      ['b', new Set<string>()],
      ['blocked', new Set(['x'])],
      ['x', new Set(['y'])],
      ['y', new Set(['x'])],
    ])
    expect(topoLayers(deps)).toEqual({
      layers: [
        ['a', 'b'],
        ['d', 'c'],
      ],
      cycle: ['blocked', 'x', 'y'],
    })
    expect(topoLayers(new Map())).toEqual({ layers: [], cycle: [] })
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

  it('节点抛错算失败，下游跳过', async () => {
    const g = new FlowGraph([e('a', 'b'), e('b', 'c')])
    const r = await runDag(g.dependencies(['a', 'b', 'c']), async (id) => {
      if (id === 'a') throw new Error('炸了')
      return 'succeeded'
    })
    expect(r.failed).toEqual(['a'])
    expect(r.skipped).toEqual(['b', 'c'])
  })

  it('同步抛错也只影响当前分支，无关节点继续执行', async () => {
    const deps = new Map([
      ['a', new Set<string>()],
      ['b', new Set(['a'])],
      ['other', new Set(['outside'])],
    ])
    const r = await runDag(deps, (id) => {
      if (id === 'a') throw new Error('同步失败')
      return Promise.resolve('succeeded')
    })
    expect(r.failed).toEqual(['a'])
    expect(r.skipped).toEqual(['b'])
    expect(r.succeeded).toEqual(['other'])
  })

  it('预先取消时不调用节点，等待中的并行节点仍要收齐结果', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const deps = new Map([['a', new Set<string>()]])
    let called = false
    const canceled = await runDag(
      deps,
      async () => {
        called = true
        return 'succeeded'
      },
      { signal: ctrl.signal },
    )
    expect(called).toBe(false)
    expect(canceled.skipped).toEqual(['a'])

    const runningCtrl = new AbortController()
    const order: string[] = []
    let releaseB!: () => void
    const pendingB = new Promise<void>((resolve) => {
      releaseB = resolve
    })
    let settled = false
    const running = runDag(
      new Map([
        ['a', new Set<string>()],
        ['b', new Set<string>()],
        ['next', new Set(['a'])],
      ]),
      async (id) => {
        order.push(id)
        if (id === 'b') {
          await pendingB
          return 'succeeded'
        }
        await Promise.resolve()
        runningCtrl.abort()
        return 'canceled'
      },
      { signal: runningCtrl.signal },
    ).then((summary) => {
      settled = true
      return summary
    })
    try {
      // 留出一轮事件循环，让 a 的取消和调度器的 Promise 回调都处理完，b 仍由测试阻塞。
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(runningCtrl.signal.aborted).toBe(true)
      expect(order).toEqual(['a', 'b'])
      expect(settled).toBe(false)
    } finally {
      releaseB()
    }
    const result = await running
    expect(result.canceled).toEqual(['a'])
    expect(result.succeeded).toEqual(['b'])
    expect(result.skipped).toEqual(['next'])
  })

  it('节点启动时同步取消，同一轮里后面的独立节点也不再启动', async () => {
    const ctrl = new AbortController()
    const order: string[] = []
    const result = await runDag(
      new Map([
        ['a', new Set<string>()],
        ['b', new Set<string>()],
      ]),
      (id) => {
        order.push(id)
        ctrl.abort()
        return Promise.resolve('canceled')
      },
      { signal: ctrl.signal },
    )
    expect(order).toEqual(['a'])
    expect(result.canceled).toEqual(['a'])
    expect(result.skipped).toEqual(['b'])
  })
})

describe('runDag 软依赖', () => {
  it('等软依赖跑完再开始；它失败时下游照常运行', async () => {
    const order: string[] = []
    const deps = new Map([
      ['ref', new Set<string>()],
      ['shot', new Set<string>()],
    ])
    const soft = new Map([['shot', new Set(['ref'])]])
    const r = await runDag(
      deps,
      async (id) => {
        order.push(id)
        return id === 'ref' ? 'failed' : 'succeeded'
      },
      { soft },
    )
    expect(order).toEqual(['ref', 'shot'])
    expect(r.failed).toEqual(['ref'])
    expect(r.succeeded).toEqual(['shot'])
  })

  it('硬依赖环及其下游跳过后，软依赖它们的节点仍能运行', async () => {
    const deps = new Map([
      ['shot', new Set<string>()],
      ['blocked', new Set(['a'])],
      ['a', new Set(['b'])],
      ['b', new Set(['a'])],
    ])
    const order: string[] = []
    const r = await runDag(
      deps,
      async (id) => {
        order.push(id)
        return 'succeeded'
      },
      { soft: new Map([['shot', new Set(['blocked', 'outside'])]]) },
    )
    expect(order).toEqual(['shot'])
    expect(r.succeeded).toEqual(['shot'])
    expect(r.skipped.sort()).toEqual(['a', 'b', 'blocked'])
  })

  it('软依赖环跳过后，硬依赖它的节点跳过，软依赖它的节点和无关分支继续', async () => {
    const deps = new Map([
      ['shot', new Set<string>()],
      ['blocked', new Set(['a'])],
      ['a', new Set<string>()],
      ['b', new Set<string>()],
      ['other', new Set<string>()],
    ])
    const r = await runDag(deps, async () => 'succeeded', {
      soft: new Map([
        ['shot', new Set(['blocked'])],
        ['a', new Set(['b'])],
        ['b', new Set(['a'])],
      ]),
    })
    expect(r.succeeded).toEqual(['other', 'shot'])
    expect(r.skipped.sort()).toEqual(['a', 'b', 'blocked'])
  })

  it('硬软依赖混合成环也只阻塞环自身，软依赖下游继续执行', async () => {
    const deps = new Map([
      ['shot', new Set<string>()],
      ['a', new Set(['b'])],
      ['b', new Set<string>()],
    ])
    const r = await runDag(deps, async () => 'succeeded', {
      soft: new Map([
        ['shot', new Set(['a'])],
        ['b', new Set(['a'])],
      ]),
    })
    expect(r.succeeded).toEqual(['shot'])
    expect(r.skipped.sort()).toEqual(['a', 'b'])
  })

  it.each(['hard', 'soft'] as const)(
    '先消解上游 %s 环，再放行只有软依赖的节点；不受目标和依赖插入顺序影响',
    async (cycleKind) => {
      const targetOrders = [
        ['a', 'b', 'c', 'd'],
        ['b', 'a', 'd', 'c'],
        ['c', 'd', 'b', 'a'],
        ['d', 'c', 'a', 'b'],
      ]
      for (const targets of targetOrders) {
        for (const aUpstream of [
          ['b', 'c'],
          ['c', 'b'],
        ]) {
          const hard = new Map([
            ['a', new Set(aUpstream)],
            ['b', new Set<string>()],
            ['c', new Set(cycleKind === 'hard' ? ['d'] : [])],
            ['d', new Set(cycleKind === 'hard' ? ['c'] : [])],
          ])
          const soft = new Map([
            ['b', new Set(['a'])],
            ...(cycleKind === 'soft'
              ? ([
                  ['c', new Set(['d'])],
                  ['d', new Set(['c'])],
                ] as const)
              : []),
          ])
          const order: string[] = []
          const result = await runDag(
            new Map(targets.map((id) => [id, hard.get(id)!])),
            async (id) => {
              order.push(id)
              return 'succeeded'
            },
            { soft },
          )
          expect(order).toEqual(['b'])
          expect(result.succeeded).toEqual(['b'])
          expect(result.skipped.sort()).toEqual(['a', 'c', 'd'])
        }
      }
    },
  )

  it('长等待环不依赖递归调用栈', async () => {
    const ids = Array.from({ length: 12_000 }, (_, i) => `node-${i}`)
    const deps = new Map(ids.map((id, i) => [id, new Set(ids[i + 1] ? [ids[i + 1]!] : [])]))
    let called = false
    const result = await runDag(
      deps,
      async () => {
        called = true
        return 'succeeded'
      },
      { soft: new Map([[ids.at(-1)!, new Set([ids[0]!])]]) },
    )
    expect(called).toBe(false)
    expect(new Set(result.skipped)).toEqual(new Set(ids))
  })
})

describe('stableStringify', () => {
  it('与键顺序无关', () => {
    expect(stableStringify({ b: 1, a: [{ y: 2, x: undefined, z: null }] })).toBe(
      stableStringify({ a: [{ z: null, y: 2 }], b: 1 }),
    )
  })

  it('值不同则字符串不同，数组里的 undefined 写成 null', () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }))
    expect(stableStringify({ a: [1, 2] })).not.toBe(stableStringify({ a: [2, 1] }))
    expect(stableStringify([1, undefined])).toBe('[1,null]')
  })

  it('稀疏数组的空槽与 undefined 一样写成 null，不与空数组共用缓存键', () => {
    const sparse: unknown[] = []
    sparse.length = 1
    expect(stableStringify(sparse)).toBe('[null]')
    expect(stableStringify(sparse)).not.toBe(stableStringify([]))
  })
})
