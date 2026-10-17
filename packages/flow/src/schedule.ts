/** 一个节点的执行结果：cached 表示结果仍然有效，没有重新运行 */
export type StepOutcome = 'succeeded' | 'cached' | 'failed' | 'canceled'

export interface DagSummary {
  succeeded: string[]
  cached: string[]
  failed: string[]
  canceled: string[]
  /** 上游失败、取消或成环而没有运行的 */
  skipped: string[]
}

/**
 * 按依赖运行一组节点：上游都成功（或命中缓存）才开始，互不依赖的并发运行；
 * 上游失败或取消时，下游整条链跳过。并发上限由调用方的任务队列控制，这里不限。
 * soft 里的是软依赖：要等它跑完再开始，但它失败、取消或被跳过时下游照常运行。
 */
export async function runDag(
  deps: ReadonlyMap<string, ReadonlySet<string>>,
  step: (id: string) => Promise<StepOutcome>,
  opts: { signal?: AbortSignal; soft?: ReadonlyMap<string, ReadonlySet<string>> } = {},
): Promise<DagSummary> {
  const summary: DagSummary = { succeeded: [], cached: [], failed: [], canceled: [], skipped: [] }
  const ok = new Set<string>()
  const bad = new Set<string>()
  const pending = new Set(deps.keys())
  const running = new Map<string, Promise<void>>()

  const upstream = new Map([...deps].map(([id, ds]) => [id, [...ds].filter((d) => deps.has(d))]))
  const soft = new Map(
    [...pending].map((id) => [id, [...(opts.soft?.get(id) ?? [])].filter((d) => deps.has(d))]),
  )
  const execute = async (id: string): Promise<StepOutcome> => {
    try {
      return await step(id)
    } catch {
      return 'failed'
    }
  }

  while (pending.size || running.size) {
    const skipped = summary.skipped.length
    for (const id of [...pending]) {
      const up = upstream.get(id)!
      if (opts.signal?.aborted || up.some((u) => bad.has(u))) {
        pending.delete(id)
        bad.add(id)
        summary.skipped.push(id)
      } else if (
        up.every((u) => ok.has(u)) &&
        soft.get(id)!.every((u) => ok.has(u) || bad.has(u))
      ) {
        pending.delete(id)
        running.set(
          id,
          execute(id).then((outcome) => {
            running.delete(id)
            summary[outcome].push(id)
            if (outcome === 'succeeded' || outcome === 'cached') ok.add(id)
            else bad.add(id)
          }),
        )
      }
    }
    if (!running.size) {
      if (!pending.size) break
      // 本轮跳过的节点可能刚解除前面节点的软依赖，先重新检查。
      if (summary.skipped.length !== skipped) continue
      // 先消解不再等待其他 pending 分量的上游环，再传播硬依赖跳过；
      // 否则下游混合环可能先被跳过，错失上游跳过后解除软依赖的机会。
      for (const blocked of upstreamCycle(pending, (id) => [
        ...upstream.get(id)!,
        ...soft.get(id)!,
      ])) {
        pending.delete(blocked)
        bad.add(blocked)
        summary.skipped.push(blocked)
      }
    } else {
      await Promise.race(running.values())
    }
  }
  return summary
}

/** 停滞时每个 pending 节点都有未决依赖，迭代 Tarjan 找到的首个分量就是终端环。 */
function upstreamCycle(pending: ReadonlySet<string>, waitsFor: (id: string) => string[]): string[] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const order: string[] = []
  const frames: Array<{ id: string; waiting: string[]; cursor: number }> = []
  const visit = (id: string) => {
    index.set(id, order.length)
    low.set(id, order.length)
    order.push(id)
    frames.push({ id, waiting: waitsFor(id).filter((source) => pending.has(source)), cursor: 0 })
  }
  visit(pending.values().next().value!)
  for (;;) {
    const frame = frames.at(-1)!
    const source = frame.waiting[frame.cursor++]
    if (source !== undefined) {
      const previous = index.get(source)
      if (previous === undefined) visit(source)
      else low.set(frame.id, Math.min(low.get(frame.id)!, previous))
    } else {
      frames.pop()
      const first = low.get(frame.id)!
      // 找到首个分量就返回，所以已访问节点都仍在 Tarjan 的分量栈中，
      // 无需单独维护 onStack；order 中的后缀就是这个终端分量。
      if (first === index.get(frame.id)) return order.slice(first)
      const parent = frames.at(-1)!
      low.set(parent.id, Math.min(low.get(parent.id)!, first))
    }
  }
}
