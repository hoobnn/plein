import type { LibraryItem } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { useLibrary } from './store'

const item = (over: Partial<LibraryItem> & { id: string; name: string }): LibraryItem => ({
  kind: 'character',
  projectId: null,
  description: '',
  tags: {},
  voice: null,
  images: [],
  video: null,
  models: [],
  profile: null,
  favorite: false,
  usedAt: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

it('从画布上的角色卡打开档案时记住目标和页签，面板接手后清掉', () => {
  const target = item({ id: 'lib_1', name: '林夏' })
  useLibrary.getState().edit(target, 'periods')
  expect(useLibrary.getState().open).toBe('character')
  expect(useLibrary.getState().takeFocus()).toBe('lib_1')
  // 目标只交接一次，之后不再重复打开同一条
  expect(useLibrary.getState().takeFocus()).toBeNull()
  expect(useLibrary.getState().takeTab()).toBe('periods')
  expect(useLibrary.getState().takeTab()).toBeNull()
})
