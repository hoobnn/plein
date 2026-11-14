import { describe, expect, it } from 'vite-plus/test'
import {
  clearReworkSession,
  readReworkSession,
  REWORK_SESSION_TTL,
  reworkSessionKey,
  writeReworkSession,
  type ReworkSession,
} from './reworkSessions'

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  }
}

function session(overrides: Partial<ReworkSession> = {}): ReworkSession {
  return {
    canvasId: 'canvas',
    sequenceId: 'sequence',
    clipInstanceId: 'instance:1',
    sourceId: 'source',
    port: 'video',
    sourceResultId: 'source-result',
    sourceRunId: 'source-run',
    sourceAssetId: 'source-asset',
    draftId: 'draft',
    expected: '{"clipInstanceId":"instance:1"}',
    candidateId: 'candidate',
    sound: 'mix',
    savedAt: 100,
    ...overrides,
  }
}

describe('rework sessions', () => {
  it('重启后按画布、序列、片段恢复同一草稿关系，id 里的冒号不串键', () => {
    const storage = memoryStorage()
    expect(writeReworkSession(session(), storage)).toBe(true)
    expect(writeReworkSession(session({ canvasId: 'other' }), storage)).toBe(true)
    expect(writeReworkSession(session({ clipInstanceId: 'instance:2' }), storage)).toBe(true)
    expect(storage.data.size).toBe(3)
    expect(readReworkSession('canvas', 'sequence', 'instance:1', 200, storage)).toMatchObject({
      draftId: 'draft',
      candidateId: 'candidate',
      sound: 'mix',
    })
    expect(readReworkSession('other', 'sequence', 'instance:1', 200, storage)?.draftId).toBe(
      'draft',
    )
    expect(readReworkSession('canvas', 'sequence', 'instance:2', 200, storage)).toBeDefined()
    expect(reworkSessionKey('canvas', 'sequence', 'instance:1')).not.toBe(
      reworkSessionKey('canvas', 'sequence', 'instance:2'),
    )
  })

  it('过期、坏数据或身份对不上的记录删除后当作没有，不猜来源', () => {
    const storage = memoryStorage()
    writeReworkSession(session(), storage)
    expect(
      readReworkSession('canvas', 'sequence', 'instance:1', 100 + REWORK_SESSION_TTL + 1, storage),
    ).toBeUndefined()
    expect(storage.data.size).toBe(0)

    storage.setItem(reworkSessionKey('canvas', 'sequence', 'instance:1'), '{不是 JSON')
    expect(readReworkSession('canvas', 'sequence', 'instance:1', 200, storage)).toBeUndefined()

    writeReworkSession(session({ sound: 'hacked' as never }), storage)
    expect(readReworkSession('canvas', 'sequence', 'instance:1', 200, storage)).toBeUndefined()

    writeReworkSession(session({ canvasId: 'elsewhere' }), storage)
    expect(readReworkSession('canvas', 'sequence', 'instance:1', 200, storage)).toBeUndefined()
  })

  it('存储不可用时返回失败，清理不抛错', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    expect(writeReworkSession(session(), broken)).toBe(false)
    expect(readReworkSession('canvas', 'sequence', 'instance:1', 200, broken)).toBeUndefined()
    expect(() => clearReworkSession('canvas', 'sequence', 'instance:1', broken)).not.toThrow()
  })
})
