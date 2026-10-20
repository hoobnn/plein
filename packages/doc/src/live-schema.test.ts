import { describe, expect, it } from 'vite-plus/test'
import * as Y from 'yjs'
import { createDoc, createElement, ReadOnlyDocError } from './index'
import { SCHEMA_VERSION } from './migrate'

describe('在线文档版本升级', () => {
  it.each([false, true])('远端升级立即阻止旧客户端写入并通知界面（空文档=%s）', (empty) => {
    const doc = createDoc(undefined, { schedule: () => {} })
    if (!empty) createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 100 })
    doc.flush()
    const before = Y.encodeStateAsUpdate(doc.ydoc)
    const peer = new Y.Doc()
    Y.applyUpdate(peer, before)
    const vector = Y.encodeStateVector(doc.ydoc)
    peer.getMap('meta').set('schemaVersion', SCHEMA_VERSION + 1)
    const seen: boolean[] = []
    doc.subscribe(() => seen.push(doc.readOnly))
    Y.applyUpdate(doc.ydoc, Y.encodeStateAsUpdate(peer, vector), 'remote-peer')
    expect(doc.meta.get('schemaVersion')).toBe(SCHEMA_VERSION + 1)
    expect(doc.readOnly).toBe(true)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION + 1)
    expect(() => createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 100 })).toThrow(
      ReadOnlyDocError,
    )
    expect(doc.size).toBe(empty ? 0 : 1)
    doc.flush()
    expect(seen).toEqual([true])
    doc.destroy()
    peer.destroy()
  })
})
