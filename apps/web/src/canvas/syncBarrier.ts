import * as Y from 'yjs'

/**
 * 浏览器文档的同步凭据与「本机还有未确认改动」的判定。
 *
 * 凭据是 `Y.encodeSnapshot(Y.snapshot(ydoc))` 的 base64：服务端据此确认它已经收到浏览器这一版
 * 文档，包含删除集——纯删除不会推进状态向量，只看 stateVector 会误判成已同步。
 *
 * 本机改动只有在两种确认后才算安全：本机缓存把这版写进 IndexedDB，或服务端把这版写进数据库。
 * 服务端「收到」还不够：改动可能还在内存里、磁盘写入可能失败，重启就没了。
 * 只有本机改动都确认安全之前，离开页面才需要保护。
 */

/** Yjs 快照的 base64 凭据 */
export function snapshotCredential(doc: Y.Doc) {
  const bytes = Y.encodeSnapshot(Y.snapshot(doc))
  let text = ''
  // 删除集可能不小，分块拼接避免一次展开过多参数
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

/** 本机改动后多久向服务端确认一次：打字期间不逐字请求 */
const CONFIRM_DELAY_MS = 300
/** 确认失败后的重试间隔与次数：断线重连、磁盘暂时不可写都靠它恢复 */
const RETRY_DELAY_MS = 1000
const RETRY_LIMIT = 10

export interface DocSync {
  canvasId: string
  /** 当前文档的同步凭据，随文档状态变化 */
  credential(): string
  /** 本机有还没确认安全的改动 */
  dirty(): boolean
  /** 本机缓存确认已把这版写进 IndexedDB */
  cacheSaved(): void
  /** 立刻向服务端确认一次（重连、界面要求时） */
  confirmNow(): Promise<void>
  dispose(): void
}

/** 正在跟踪的画布文档；没有远端画布（演示）时为空 */
let active: DocSync | null = null

/** 请求要带的同步凭据；不是当前画布时为空，不拿别的画布凭据去提交 */
export function canvasSyncCredential(canvasId: string): string | undefined {
  return active?.canvasId === canvasId ? active.credential() : undefined
}

/** 当前画布是否还有本机独有、服务端与本机缓存都没确认的改动 */
export function hasUnconfirmedLocalEdits() {
  return active?.dirty() ?? false
}

/**
 * 跟踪一份远端画布文档：记录本机改动、向服务端确认持久化、把未保存状态报给界面。
 * `remote` 是同步连接（y-websocket）的 origin，来自服务端的更新不算本机改动；
 * `cache` 是 IndexedDB 的 origin，回放本机缓存也不算。
 */
export function watchDocSync(options: {
  canvasId: string
  ydoc: Y.Doc
  remote: unknown
  cache?: unknown
  /** 现在能不能向服务端确认（断开时只留未保存状态，等重连） */
  connected(): boolean
  /** 让服务端确认已经把这版文档写进数据库 */
  probe(credential: string): Promise<boolean>
  /** 未保存状态变化 */
  change(dirty: boolean): void
}): DocSync {
  const { ydoc, remote, cache } = options
  /** 本机改动计数：只在浏览器自己写入时增加，远端更新与缓存回放都不算 */
  let revision = 0
  let saved = 0
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let attempts = 0
  let disposed = false
  const report = (next: boolean) => {
    if (dirty === next) return
    dirty = next
    options.change(next)
  }
  const schedule = (delay: number) => {
    clearTimeout(timer)
    if (disposed || !options.connected()) return
    timer = setTimeout(() => void confirmNow(), delay)
  }
  const confirmNow = async () => {
    clearTimeout(timer)
    if (disposed || !dirty || !options.connected()) return
    // 只关心「最新一次本机改动」有没有落库：期间收到的远端更新不影响这次确认
    const asked = revision
    const credential = snapshotCredential(ydoc)
    let ok = false
    try {
      ok = await options.probe(credential)
    } catch {
      ok = false
    }
    if (disposed) return
    if (!ok) {
      // 一次没确认不代表失败：重连、写库恢复后继续重试
      attempts++
      if (attempts <= RETRY_LIMIT) schedule(RETRY_DELAY_MS)
      return
    }
    attempts = 0
    if (asked === revision) {
      saved = revision
      report(false)
    } else {
      // 请求期间又改过：这一版是旧的，继续确认新的
      schedule(CONFIRM_DELAY_MS)
    }
  }
  const update = (_update: Uint8Array, origin: unknown) => {
    if (origin === remote || (cache !== undefined && origin === cache)) return
    revision++
    attempts = 0
    report(true)
    schedule(CONFIRM_DELAY_MS)
  }
  ydoc.on('update', update)

  const sync: DocSync = {
    canvasId: options.canvasId,
    credential: () => snapshotCredential(ydoc),
    dirty: () => dirty,
    cacheSaved() {
      // 本机缓存把这之前的改动都写进去了：刷新能恢复，不必再等服务器
      saved = revision
      attempts = 0
      report(false)
    },
    confirmNow,
    dispose() {
      disposed = true
      clearTimeout(timer)
      ydoc.off('update', update)
      if (active === sync) active = null
      report(false)
    },
  }
  active = sync
  void saved
  return sync
}
