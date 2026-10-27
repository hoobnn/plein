// @vitest-environment happy-dom
import { expect, it, vi } from 'vite-plus/test'
import { api } from '../api/client'
import { finishPendingRequests, mockFetch, takeUnhandledRequests } from './fetch'
import './render'

it('真实 API client 的路径、方法和 JSON 正文通过 Request 传给替身', async () => {
  const received: Array<{
    path: string
    method: string
    contentType: string | null
    body: unknown
  }> = []
  mockFetch(async (request) => {
    received.push({
      path: new URL(request.url).pathname,
      method: request.method,
      contentType: request.headers.get('content-type'),
      body: await request.json(),
    })
    return Response.json({ id: '项目 / 1', title: '雨后' })
  })
  await expect(api.renameProject('项目 / 1', '雨后')).resolves.toEqual({
    id: '项目 / 1',
    title: '雨后',
  })
  expect(received).toEqual([
    {
      path: '/api/projects/%E9%A1%B9%E7%9B%AE%20%2F%201',
      method: 'PATCH',
      contentType: 'application/json',
      body: { title: '雨后' },
    },
  ])
})

it('调用前已取消的 API 请求不进入 handler', async () => {
  const handler = vi.fn(() => Response.json({}))
  mockFetch(handler)
  const controller = new AbortController()
  controller.abort()
  await expect(api.groupRun('group-1', controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  })
  expect(handler).not.toHaveBeenCalled()
})

it('等待中的 API 请求取消后立即拒绝，迟到应答不触发成功处理', async () => {
  let release!: (response: Response) => void
  const deferred = new Promise<Response>((resolve) => {
    release = resolve
  })
  const handler = vi.fn(() => deferred)
  mockFetch(handler)
  const controller = new AbortController()
  const success = vi.fn()
  const response = api.groupRun('group-1', controller.signal).then(success)
  const rejected = expect(response).rejects.toMatchObject({ name: 'AbortError' })
  await Promise.resolve()
  expect(handler).toHaveBeenCalledTimes(1)
  controller.abort()
  await rejected
  release(Response.json({ state: 'done' }))
  await deferred
  await Promise.resolve()
  expect(success).not.toHaveBeenCalled()
  expect(await finishPendingRequests()).toEqual([])
})

it('调用方捕获未声明请求后，teardown 仍能识别遗漏', async () => {
  mockFetch()
  expect(await api.project('missing').catch(() => null)).toBeNull()
  expect(takeUnhandledRequests()).toEqual([
    `未模拟的请求：GET ${location.origin}/api/projects/missing`,
  ])
})

it('收尾报告并拒绝未完成请求，迟到成功不能越过用例边界', async () => {
  let release!: (response: Response) => void
  const deferred = new Promise<Response>((resolve) => {
    release = resolve
  })
  mockFetch(() => deferred)
  const success = vi.fn()
  const response = api.renameProject('project-1', '旧草稿').then(success, (error: unknown) => error)
  await Promise.resolve()
  expect(await finishPendingRequests()).toEqual([
    `未完成的请求：PATCH ${location.origin}/api/projects/project-1`,
  ])
  expect(await response).toMatchObject({ name: 'AbortError' })
  release(Response.json({ id: 'project-1', title: '旧草稿' }))
  await deferred
  await Promise.resolve()
  expect(success).not.toHaveBeenCalled()
  expect(await finishPendingRequests()).toEqual([])
})

it('显式网络失败保留原始异常，不计为未声明请求', async () => {
  mockFetch(() => {
    throw new TypeError('连接中断')
  })
  await expect(api.projects()).rejects.toThrow('连接中断')
  expect(takeUnhandledRequests()).toEqual([])
  expect(await finishPendingRequests()).toEqual([])
})
