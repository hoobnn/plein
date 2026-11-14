import * as Y from 'yjs'

/**
 * 服务端文档是否已经包含客户端给出的快照：状态向量要追平，删除集也要覆盖。
 * 只看状态向量不够——纯删除不会推进状态向量，两端的 stateVector 可能完全一致。
 */
export function includesSnapshot(actual: Y.Snapshot, expected: Y.Snapshot) {
  return (
    [...expected.sv].every(([client, clock]) => (actual.sv.get(client) ?? 0) >= clock) &&
    Y.equalDeleteSets(actual.ds, Y.mergeDeleteSets([actual.ds, expected.ds]))
  )
}

/**
 * 解析客户端带来的同步凭据（`Y.encodeSnapshot(Y.snapshot(doc))` 的 base64）。
 * 没带返回 undefined；格式不对返回 null，让调用方给出可理解的错误而不是 500。
 */
export function decodeSyncCredential(value: string | undefined): Y.Snapshot | null | undefined {
  if (value === undefined) return undefined
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null
    return Y.decodeSnapshot(Buffer.from(value, 'base64'))
  } catch {
    return null
  }
}

/** 文档当前状态的同步凭据，测试与客户端用同一套编码 */
export function snapshotCredential(doc: Y.Doc) {
  return Buffer.from(Y.encodeSnapshot(Y.snapshot(doc))).toString('base64')
}
