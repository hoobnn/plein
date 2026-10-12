/**
 * 工作流图：画布上的元素是点，连线是边。这里只关心依赖关系，不关心元素是什么，
 * 前后端都可以用。
 */

export interface FlowEdge {
  from: readonly [id: string, port: string]
  to: readonly [id: string, port: string]
}

export class FlowGraph {
  /** id → 直接上游 */
  private up = new Map<string, Set<string>>()
  /** id → 直接下游 */
  private down = new Map<string, Set<string>>()

  constructor(edges: Iterable<FlowEdge>) {
    for (const e of edges) {
      const [a] = e.from
      const [b] = e.to
      if (a === b) continue
      link(this.up, b, a)
      link(this.down, a, b)
    }
  }

  upstream(id: string): ReadonlySet<string> {
    return this.up.get(id) ?? EMPTY
  }

  downstream(id: string): ReadonlySet<string> {
    return this.down.get(id) ?? EMPTY
  }

  /** 所有上游（不含自己） */
  ancestors(id: string): Set<string> {
    return walk(id, (x) => this.upstream(x))
  }

  /** 所有下游（不含自己） */
  descendants(id: string): Set<string> {
    return walk(id, (x) => this.downstream(x))
  }

  /**
   * 只看 targets 之间的依赖：A 经过任意中间元素（不在 targets 里的，例如纯文本节点）
   * 连到 B，B 就依赖 A。返回每个目标依赖的其他目标。
   */
  dependencies(targets: Iterable<string>): Map<string, Set<string>> {
    const set = new Set(targets)
    const deps = new Map<string, Set<string>>()
    for (const id of set) {
      const found = new Set<string>()
      const seen = new Set<string>([id])
      const stack = [...this.upstream(id)]
      while (stack.length) {
        const x = stack.pop()!
        if (seen.has(x)) continue
        seen.add(x)
        // 碰到目标就停：更上游的目标由它负责等待
        if (set.has(x)) found.add(x)
        else stack.push(...this.upstream(x))
      }
      deps.set(id, found)
    }
    return deps
  }
}

const EMPTY: ReadonlySet<string> = new Set()

function link(map: Map<string, Set<string>>, key: string, value: string) {
  let s = map.get(key)
  if (!s) {
    s = new Set()
    map.set(key, s)
  }
  s.add(value)
}

function walk(start: string, next: (id: string) => ReadonlySet<string>) {
  const out = new Set<string>()
  const stack = [...next(start)]
  while (stack.length) {
    const x = stack.pop()!
    if (out.has(x) || x === start) continue
    out.add(x)
    stack.push(...next(x))
  }
  return out
}

/**
 * 按依赖排出执行顺序（Kahn 算法），同一层可以并发。
 * 成环的节点放进 cycle，不出现在 layers 里。
 */
export function topoLayers(deps: ReadonlyMap<string, ReadonlySet<string>>): {
  layers: string[][]
  cycle: string[]
} {
  const remaining = new Map<string, Set<string>>()
  for (const [id, d] of deps) remaining.set(id, new Set([...d].filter((x) => deps.has(x))))
  const layers: string[][] = []
  for (;;) {
    const ready = [...remaining].filter(([, d]) => d.size === 0).map(([id]) => id)
    if (ready.length === 0) break
    layers.push(ready)
    for (const id of ready) remaining.delete(id)
    for (const d of remaining.values()) for (const id of ready) d.delete(id)
  }
  return { layers, cycle: [...remaining.keys()] }
}
