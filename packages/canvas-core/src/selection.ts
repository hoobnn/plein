/** 选中状态：运行时状态，不进文档 */
export class Selection {
  private ids = new Set<string>()
  private listeners = new Set<() => void>()

  onChange(fn: () => void) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  get size() {
    return this.ids.size
  }

  has(id: string) {
    return this.ids.has(id)
  }

  values(): string[] {
    return [...this.ids]
  }

  set(ids: Iterable<string>) {
    const next = new Set(ids)
    if (next.size === this.ids.size && [...next].every((id) => this.ids.has(id))) return
    this.ids = next
    this.emit()
  }

  toggle(id: string) {
    const next = new Set(this.ids)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    this.set(next)
  }

  clear() {
    this.set([])
  }

  /** 去掉已不存在的元素（撤销、远端删除之后） */
  prune(exists: (id: string) => boolean) {
    const next = [...this.ids].filter(exists)
    if (next.length !== this.ids.size) this.set(next)
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }
}
