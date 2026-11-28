import type { ExternalTarget } from '@plein/protocol'
import { projectLockKey } from './targets'

/** Each local service serializes work on a remote project, including its legacy space aliases. */
export class ProjectQueue {
  private readonly tails = new Map<string, { result: Promise<unknown>; barrier: symbol }>()

  run<T>(ref: ExternalTarget, work: () => Promise<T>): Promise<T> {
    return this.enqueue(projectLockKey(ref), Symbol(), work)
  }

  private enqueue<T>(key: string, barrier: symbol, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key)?.result ?? Promise.resolve()
    // A failed operation still releases the next request, which rechecks its own inputs.
    const result = previous.then(work, work).finally(() => {
      if (this.tails.get(key)?.result === result) this.tails.delete(key)
    })
    this.tails.set(key, { result, barrier })
    return result
  }

  /** Other readers can coexist in the same batch. An enqueued write immediately
   * separates subsequent reads, even before the write itself has begun. */
  reader<T>() {
    const reads = new Map<string, { barrier: symbol; result: Promise<T> }>()
    return (canvasId: string, ref: ExternalTarget, work: () => Promise<T>): Promise<T> => {
      const key = projectLockKey(ref)
      const barrier = this.tails.get(key)?.barrier ?? Symbol()
      // Canvas IDs are globally unique and ownership is checked before entering the queue.
      const scope = JSON.stringify([canvasId, ref.provider, ref.target])
      const active = reads.get(scope)
      if (active?.barrier === barrier) return active.result
      const result = this.enqueue(key, barrier, async () => {
        try {
          return await work()
        } finally {
          if (reads.get(scope)?.barrier === barrier) reads.delete(scope)
        }
      })
      reads.set(scope, { barrier, result })
      return result
    }
  }
}
