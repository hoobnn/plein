import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * 文件写入租约：上传、衍生生成和项目导入之间可以并行；维护操作必须独占。
 * AsyncLocalStorage 允许导入 → place、ingest → place 嵌套而不重复等待自己。
 */
export class DataActivity {
  private active = 0
  generation = 0
  private locked = false
  private waiting: Array<() => void> = []
  private context = new AsyncLocalStorage<{ active: boolean }>()

  get busy() {
    return this.active > 0 || this.locked
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.context.getStore()?.active) return fn()
    while (this.locked) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active++
    this.generation++
    const lease = { active: true }
    try {
      return await this.context.run(lease, fn)
    } finally {
      lease.active = false
      this.active--
      this.generation++
    }
  }

  /** 不排队抢占正在写素材的任务：用户可以在任务结束后重试。 */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('素材正在写入或另一项维护尚未完成，请稍后重试')
    this.locked = true
    const lease = { active: true }
    try {
      return await this.context.run(lease, fn)
    } finally {
      lease.active = false
      this.locked = false
      for (const resolve of this.waiting.splice(0)) resolve()
    }
  }
}
