import { describe, expect, it } from 'vite-plus/test'
import { runRequestKey, useRunRequests } from './runRequests'

describe('生成请求的提交保护', () => {
  it('同一个节点在等待应答期间只允许一次提交', () => {
    const key = runRequestKey('cv1', 'n1')
    const requests = useRunRequests.getState()
    requests.end(key)
    expect(requests.begin(key)).toBe(true)
    // 第二次提交被挡住，不会重复发请求
    expect(requests.begin(key)).toBe(false)
    requests.end(key)
    // 应答回来之后可以再次提交
    expect(requests.begin(key)).toBe(true)
    requests.end(key)
  })

  it('不同节点互不影响', () => {
    const a = runRequestKey('cv1', 'n1')
    const b = runRequestKey('cv1', 'n2')
    const requests = useRunRequests.getState()
    requests.end(a)
    requests.end(b)
    expect(requests.begin(a)).toBe(true)
    expect(requests.begin(b)).toBe(true)
    requests.end(a)
    requests.end(b)
  })

  it('不同画布的同一节点互不影响', () => {
    const a = runRequestKey('cv1', 'n1')
    const b = runRequestKey('cv2', 'n1')
    const requests = useRunRequests.getState()
    requests.end(a)
    requests.end(b)
    expect(requests.begin(a)).toBe(true)
    expect(requests.begin(b)).toBe(true)
    requests.end(a)
    requests.end(b)
  })

  it('结束不存在的键不会出错', () => {
    const requests = useRunRequests.getState()
    expect(() => requests.end('不存在的键')).not.toThrow()
    expect(requests.pending.size).toBe(0)
  })
})
