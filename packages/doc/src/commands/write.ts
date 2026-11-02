import type { PleinDoc } from '../doc'

/**
 * 命令式写入 API。每个命令是一个带 doc.origin（默认 LOCAL_ORIGIN）的事务，
 * 撤销按命令（及 captureTimeout 内的连续命令）为一步。
 */

export class ReadOnlyDocError extends Error {
  constructor() {
    super('文档版本高于当前客户端，只能只读打开')
  }
}

export function write<T>(doc: PleinDoc, fn: () => T): T {
  if (doc.readOnly) throw new ReadOnlyDocError()
  let out!: T
  doc.ydoc.transact(() => {
    out = fn()
  }, doc.origin)
  return out
}
