// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vite-plus/test'
import { pushRecentModel, readRecentModels, recentModelsKey } from './recentModels'

describe('最近使用的模型', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('按用户分别存放，互不串用', () => {
    expect(recentModelsKey('alice')).toBe('plein:recent-models:alice')
    expect(recentModelsKey(null)).toBe('plein:recent-models:local')
    expect(recentModelsKey(undefined)).toBe('plein:recent-models:local')
  })

  it('选了模型后按顺序累积，不只剩最新那一个', () => {
    const key = recentModelsKey('alice')
    pushRecentModel(key, 'p:a')
    pushRecentModel(key, 'p:b')
    pushRecentModel(key, 'p:c')
    expect(readRecentModels(key)).toEqual(['p:c', 'p:b', 'p:a'])
  })

  it('会话就绪后换到真实键，不会把上一个键的历史混进来', () => {
    // 挂载时还没读到用户，读到的是 local 键的内容
    pushRecentModel(recentModelsKey(null), 'p:local-only')
    // 用户就绪后换成真实键：这时读到的是真实键下的内容，
    // 不能把 local 键里的模型混进真实用户的「最近」
    const key = recentModelsKey('alice')
    expect(readRecentModels(key)).toEqual([])
    pushRecentModel(key, 'p:alice')
    expect(readRecentModels(key)).toEqual(['p:alice'])
    expect(readRecentModels(recentModelsKey(null))).toEqual(['p:local-only'])
  })

  it('重复选择同一个模型只留最靠前的一次', () => {
    const key = recentModelsKey('alice')
    pushRecentModel(key, 'p:a')
    pushRecentModel(key, 'p:b')
    pushRecentModel(key, 'p:a')
    expect(readRecentModels(key)).toEqual(['p:a', 'p:b'])
  })

  it('最多保留 6 条，坏数据当作没有', () => {
    const key = recentModelsKey('alice')
    for (const ref of ['1', '2', '3', '4', '5', '6', '7', '8']) pushRecentModel(key, ref)
    expect(readRecentModels(key)).toHaveLength(6)
    localStorage.setItem(key, 'not json')
    expect(readRecentModels(key)).toEqual([])
    localStorage.setItem(key, JSON.stringify([1, 'ok']))
    expect(readRecentModels(key)).toEqual(['ok'])
  })
})
