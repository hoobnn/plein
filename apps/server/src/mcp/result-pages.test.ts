import { expect, it, vi } from 'vite-plus/test'
import { ResultPages } from './result-pages'

it('已执行回执按容量、时限和令牌撤销释放，单项过大时说明恢复限制', () => {
  vi.useFakeTimers()
  const pages = new ResultPages()
  const size = 4 * 1024 * 1024
  try {
    expect(pages.save('a', 'x'.repeat(size + 1))).toMatchObject({
      reason: 'result_exceeds_retention_limit',
      max_bytes: size,
    })
    const payload = 'x'.repeat(size)
    const oldest = pages.save('a', payload).uri!
    let newest = ''
    for (let i = 0; i < 4; i++) newest = pages.save('a', payload).uri!
    expect(() => pages.read('a', oldest)).toThrow('释放')
    expect(() => pages.read('a', newest)).not.toThrow()
    const other = pages.save('b', '另一条回执').uri!
    pages.revoke('a')
    expect(() => pages.read('a', newest)).toThrow('释放')
    expect(pages.read('b', other).text).toBe('另一条回执')
    vi.advanceTimersByTime(30 * 60_000)
    expect(() => pages.read('b', other)).toThrow('到期')
  } finally {
    pages.revoke()
    vi.useRealTimers()
  }
})
