import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { ApiError } from '../../api/client'
import { mediaApi, mediaQuery, mediaRequest } from './client'

afterEach(() => vi.restoreAllMocks())

const online = (value: boolean) =>
  Object.defineProperty(globalThis.navigator, 'onLine', {
    value,
    configurable: true,
  })

describe('素材请求的失败提示', () => {
  it('离线与服务不可达给出不同的提示，不说成同一句话', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    fetch.mockRejectedValueOnce(new TypeError('failed to fetch'))
    online(false)
    await expect(mediaRequest('/api/assets')).rejects.toThrow('当前离线，请恢复网络连接。')

    fetch.mockRejectedValueOnce(new TypeError('failed to fetch'))
    online(true)
    await expect(mediaRequest('/api/assets')).rejects.toThrow(
      '无法连接服务，请检查网络或本地服务状态。',
    )
  })

  it('已取消的请求原样抛出 AbortError，不当成网络故障', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('已取消', 'AbortError'))
    await expect(mediaRequest('/api/assets', { signal: controller.signal })).rejects.toThrow(
      '已取消',
    )
  })

  it('服务端错误带上状态码与文案，分页游标无效可以按 400 invalid 识别', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ error: 'invalid', message: '分页游标无效，请重新读取素材' }, { status: 400 }),
    )
    const reason = await mediaRequest('/api/assets?cursor=bad').catch((error: unknown) => error)
    expect(reason).toBeInstanceOf(ApiError)
    expect(reason).toMatchObject({ status: 400, code: 'invalid' })
    expect((reason as Error).message).toBe('分页游标无效，请重新读取素材')
  })

  it('204 没有正文时返回空值，不当作解析失败', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await mediaRequest('/api/assets')).toBeUndefined()
  })

  it('服务端没有可读文案时也给出能看懂的原因，不留空提示', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 500 }))
    const reason = await mediaRequest('/api/assets').catch((error: unknown) => error)
    expect((reason as Error).message).toContain('500')
    expect((reason as Error).message).not.toBe('')
  })

  it('正文没有文案时用状态说明兜底，说清是哪一类失败', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid' }), {
        status: 503,
        statusText: 'Service Unavailable',
      }),
    )
    const reason = await mediaRequest('/api/assets').catch((error: unknown) => error)
    // 服务端只给了错误码时，用状态说明兜底，不给用户一个空提示
    expect((reason as Error).message).toBe('Service Unavailable')
    expect((reason as Error).message).not.toBe('')
  })
})

describe('素材请求参数', () => {
  it('空值不参与查询，其余原样保留', () => {
    expect(mediaQuery({ projectId: '', kind: undefined, q: '边界', limit: 50 })).toBe(
      'q=%E8%BE%B9%E7%95%8C&limit=50',
    )
  })

  it('列表与来源请求带上自己的查询参数', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    fetch.mockImplementation(async () => Response.json({ items: [], nextCursor: null }))
    await mediaApi.list({ projectId: 'p1', kind: 'image', q: '杯子' })
    expect(fetch.mock.calls[0]![0]).toBe('/api/assets?projectId=p1&kind=image&q=%E6%9D%AF%E5%AD%90')

    fetch.mockClear()
    await mediaApi.sources('asset-1', 'cursor-1')
    expect(fetch.mock.calls[0]![0]).toBe('/api/assets/asset-1/sources?cursor=cursor-1')
  })
})
