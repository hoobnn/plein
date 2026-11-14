import { describe, expect, it } from 'vite-plus/test'
import type { WorkbenchDraft } from './shotWorkbenchModel'
import {
  discardWorkbenchDraft,
  readWorkbenchDraft,
  saveWorkbenchDraft,
  WORKBENCH_DRAFT_MAX_FIELD,
  workbenchDraftDirty,
  workbenchDraftKey,
} from './workbenchDrafts'

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  }
}

function draft(
  values: Partial<WorkbenchDraft['values']> = {},
  overrides: Partial<WorkbenchDraft> = {},
): WorkbenchDraft {
  return {
    boardId: 'board',
    shotId: 'one',
    source: '{"id":"one"}',
    values: {
      description: '画面',
      imagePrompt: '首帧',
      motionPrompt: '运动',
      lighting: '光影',
      ...values,
    },
    ...overrides,
  }
}

describe('workbench drafts', () => {
  it('按画布、分镜表、镜头隔离保存，重启后只恢复真正有未保存内容的草稿', () => {
    const storage = memoryStorage()
    const formal = draft()
    expect(saveWorkbenchDraft('canvas-a', draft({ description: '草稿一' }), storage)).toBe('saved')
    expect(
      saveWorkbenchDraft('canvas-a', draft({ description: '草稿二' }, { shotId: 'two' }), storage),
    ).toBe('saved')
    expect(saveWorkbenchDraft('canvas-b', draft({ description: '另一画布' }), storage)).toBe(
      'saved',
    )
    expect(
      readWorkbenchDraft('canvas-a', 'board', 'one', formal, storage)?.values.description,
    ).toBe('草稿一')
    expect(readWorkbenchDraft('canvas-a', 'board', 'two', formal, storage)).toMatchObject({
      shotId: 'two',
      values: { description: '草稿二' },
    })
    expect(
      readWorkbenchDraft('canvas-b', 'board', 'one', formal, storage)?.values.description,
    ).toBe('另一画布')
    // 草稿和正式内容一致时只是残留记录，读取时清掉
    expect(
      readWorkbenchDraft(
        'canvas-a',
        'board',
        'two',
        draft({ description: '草稿二' }, { shotId: 'two' }),
        storage,
      ),
    ).toBeUndefined()
    expect(storage.data.get(workbenchDraftKey('canvas-a', 'board'))).not.toContain('"two"')
  })

  it('正式镜头已删除时清掉草稿，不把孤立内容恢复给别的镜头', () => {
    const storage = memoryStorage()
    saveWorkbenchDraft('canvas', draft({ description: '孤儿' }), storage)
    expect(readWorkbenchDraft('canvas', 'board', 'one', undefined, storage)).toBeUndefined()
    expect(storage.data.has(workbenchDraftKey('canvas', 'board'))).toBe(false)
    expect(readWorkbenchDraft(null, 'board', 'one', draft(), storage)).toBeUndefined()
  })

  it('超长或存储不可用时明确失败，不留下看似保存成功的记录', () => {
    const storage = memoryStorage()
    expect(
      saveWorkbenchDraft(
        'canvas',
        draft({ description: 'a'.repeat(WORKBENCH_DRAFT_MAX_FIELD + 1) }),
        storage,
      ),
    ).toBe('too-large')
    expect(storage.data.size).toBe(0)
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {},
    }
    expect(saveWorkbenchDraft('canvas', draft({ description: '写不下' }), broken)).toBe(
      'unavailable',
    )
    expect(
      readWorkbenchDraft('canvas', 'board', 'one', draft({ description: '旧' }), broken),
    ).toBeUndefined()
  })

  it('同一分镜表只保留最近的草稿，丢弃后不再恢复', () => {
    const storage = memoryStorage()
    for (let i = 0; i < 30; i++)
      saveWorkbenchDraft(
        'canvas',
        draft({ description: `草稿 ${i}` }, { shotId: `shot-${i}` }),
        storage,
        1 + i,
      )
    const stored = JSON.parse(storage.data.get(workbenchDraftKey('canvas', 'board'))!) as Record<
      string,
      unknown
    >
    expect(Object.keys(stored)).toHaveLength(24)
    expect(stored['shot-0']).toBeUndefined()
    expect(stored['shot-29']).toBeDefined()
    discardWorkbenchDraft('canvas', 'board', 'shot-29', storage)
    expect(
      readWorkbenchDraft('canvas', 'board', 'shot-29', draft({}, { shotId: 'shot-29' }), storage),
    ).toBeUndefined()
  })

  it('只把与正式字段不同的内容算作需要保留的草稿', () => {
    const formal = draft()
    expect(workbenchDraftDirty(formal, formal)).toBe(false)
    expect(workbenchDraftDirty(draft({ lighting: '新光影' }), formal)).toBe(true)
    expect(workbenchDraftDirty(undefined, formal)).toBe(false)
  })
})
