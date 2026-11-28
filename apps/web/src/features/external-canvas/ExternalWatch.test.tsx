// @vitest-environment happy-dom
import { expect, it, vi } from 'vite-plus/test'
import type { ExternalRow } from '@plein/protocol'
import { api } from '../../api/client'
import { syncLinked } from './ExternalWatch'

it('编辑时只同步可写的单侧改动，冲突、未绑定节点和已删除的一侧保留待复核', async () => {
  const target = { provider: 'jimeng-novel' as const, target: '1000' }
  const states: ExternalRow['state'][] = [
    'local-only',
    'remote-only',
    'local-changed',
    'remote-changed',
    'conflict',
    'missing-local',
    'missing-remote',
    'pending',
    'synced',
  ]
  const rows = states.map((state, i): ExternalRow => ({
    rowId: String(i),
    revision: String(i),
    kind: 'text',
    state,
    remote: null,
    local: null,
    remoteId: null,
    localId: null,
    actions: ['pull', 'push', 'unlink'],
  }))
  const preview = vi.spyOn(api, 'externalCanvasPreview').mockResolvedValue({ ...target, rows })
  const apply = vi.spyOn(api, 'externalCanvasApply').mockResolvedValue(undefined)
  try {
    expect(await syncLinked({ target, canvasId: 'canvas' }, new AbortController().signal)).toEqual({
      attention: 4,
      applied: 2,
    })
    expect(apply.mock.calls.map(([, r]) => [r.rowId, r.action])).toEqual([
      ['2', 'push'],
      ['3', 'pull'],
    ])
  } finally {
    preview.mockRestore()
    apply.mockRestore()
  }
})
