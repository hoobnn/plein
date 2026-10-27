import { expect, it, vi } from 'vite-plus/test'
import { DRAMA_START, queueStartNode, takeStartNode, watchStartNode } from './startQueue'
it.each(['plein/llm', DRAMA_START])(
  '迟到的 %s 意图通知已经打开的画布且只消费一次',
  async (type) => {
    const canvas = `late-${type}`
    const taken: Array<string | undefined> = []
    const stop = watchStartNode(canvas, () => taken.push(takeStartNode(canvas)))
    queueStartNode(canvas, type)
    expect(taken).toEqual([])
    await Promise.resolve()
    expect(taken).toEqual([type])
    expect(takeStartNode(canvas)).toBeUndefined()
    stop()
  },
)
it('不同画布意图隔离，关闭监听后不响应新意图，稍后仍可领取', async () => {
  const listener = vi.fn(),
    stop = watchStartNode('a', listener)
  queueStartNode('b', DRAMA_START)
  await Promise.resolve()
  expect(listener).not.toHaveBeenCalled()
  stop()
  queueStartNode('a', 'plein/llm')
  await Promise.resolve()
  expect(listener).not.toHaveBeenCalled()
  expect(takeStartNode('a')).toBe('plein/llm')
  expect(takeStartNode('b')).toBe(DRAMA_START)
})
