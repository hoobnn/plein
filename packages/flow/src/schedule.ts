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

  const blockedBy = (id: string) => [...deps.get(id)!].filter((d) => deps.has(d))
  const waitsFor = (id: string) => [...(opts.soft?.get(id) ?? [])].filter((d) => deps.has(d))

  while (pending.size || running.size) {
    for (const id of [...pending]) {
      const up = blockedBy(id)
      if (opts.signal?.aborted || up.some((u) => bad.has(u))) {
        pending.delete(id)
        bad.add(id)
        summary.skipped.push(id)
      } else if (up.every((u) => ok.has(u)) && waitsFor(id).every((u) => ok.has(u) || bad.has(u))) {
        pending.delete(id)
        running.set(
          id,
          step(id)
            .catch((): StepOutcome => 'failed')
            .then((outcome) => {
              running.delete(id)
              summary[outcome].push(id)
              if (outcome === 'succeeded' || outcome === 'cached') ok.add(id)
              else bad.add(id)
            }),
        )
      }
    }
    // 剩下的互相等待（成环）
    if (!running.size) {
      summary.skipped.push(...pending)
      break
    }
    await Promise.race(running.values())
  }
  return summary
}
