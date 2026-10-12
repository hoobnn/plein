import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, setUnauthorizedHandler } from './client'

const reply = (status: number, body?: string, statusText = '') =>
  vi.fn(async () => new Response(body ?? null, { status, statusText }))

const onUnauthorized = vi.fn()
beforeEach(() => setUnauthorizedHandler(onUnauthorized))
afterEach(() => {
  vi.unstubAllGlobals()
  onUnauthorized.mockReset()
})

/** 跑一次请求，返回抛出的 ApiError */
const failure = (p: Promise<unknown>) =>
  p.then(
    () => expect.unreachable('应当失败'),
    (err: unknown) => {
      expect(err).toBeInstanceOf(ApiError)
      return err as ApiError
    },
  )

describe('请求', () => {
  it('普通接口 401 时回登录页；登录相关接口 401 只报错', async () => {
    vi.stubGlobal('fetch', reply(401, '{"error":"unauthorized"}'))
    await failure(api.projects())
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    // 密码错也是 401，不能把登录页再刷一遍
    const err = await failure(api.login({ email: 'a@b.c', password: 'x' }))
    expect(err.status).toBe(401)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['{"error":"not_found","message":"没有这个项目"}', 'not_found', '没有这个项目'],
    ['{"code":"too_large"}', 'too_large', 'Bad'],
    ['<html>502</html>', 'http_error', 'Bad'],
    ['', 'http_error', 'Bad'],
  ])('错误响应体 %s 转成对应的 ApiError', async (body, code, message) => {
    vi.stubGlobal('fetch', reply(404, body, 'Bad'))
    const err = await failure(api.projects())
    expect(err).toMatchObject({ status: 404, code, message })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('没有响应体的成功应答返回 undefined，有就解析 JSON', async () => {
    vi.stubGlobal('fetch', reply(204))
    await expect(api.deleteProject('p1')).resolves.toBeUndefined()
    vi.stubGlobal('fetch', reply(200, '[{"id":"p1"}]'))
    await expect(api.projects()).resolves.toEqual([{ id: 'p1' }])
  })
})
