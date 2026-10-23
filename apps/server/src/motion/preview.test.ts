import { afterEach, describe, expect, it } from 'vite-plus/test'
import type { AssetStore } from '../assets/store'
import { MotionPreviews } from './preview'

const opened: MotionPreviews[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((preview) => preview.close()))
})
const service = () => {
  const previews = new MotionPreviews({ get: () => undefined } as unknown as AssetStore)
  opened.push(previews)
  return previews
}

describe('motion preview security boundary', () => {
  it.each(['*', 'null', 'file:///private/a', 'javascript:alert(1)', 'http://localhost:5173/path'])(
    'rejects an ambiguous parent origin %s',
    async (origin) => {
      await expect(service().open('owner', {}, {}, origin)).rejects.toThrow()
    },
  )
  it('does not reopen after application shutdown', async () => {
    const previews = service()
    await previews.close()
    await expect(previews.open('owner', {}, {}, 'http://localhost:5173')).rejects.toThrow('已关闭')
  })
  it('binds preview commands to parent window, exact origin, id and nonce; release is owner scoped', async () => {
    const previews = service()
    const info = await previews.open(
      'owner',
      { title: 'fetch(1) / url(1)' },
      {},
      'http://localhost:5173',
    )
    const response = await fetch(info.url)
    expect(response.ok).toBe(true)
    const html = await response.text()
    expect(html).toContain('e.source!==parent')
    expect(html).toContain('e.origin!==config.origin')
    expect(html).toContain('m.id!==config.id')
    expect(html).toContain('m.nonce!==config.nonce')
    expect(html).toContain("m.command==='dispose'")
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'")
    expect(response.headers.get('content-security-policy')).toContain("form-action 'none'")
    expect(response.headers.get('cache-control')).toBe('no-store')
    const composition = await fetch(new URL('composition.html', info.url))
    expect(await composition.text()).toContain('fetch(1) / url(1)')
    expect((await fetch(new URL('not-a-package-file', info.url))).status).toBe(404)
    expect(previews.release('other-owner', info.id)).toBe(false)
    expect(previews.release('owner', info.id)).toBe(true)
    expect((await fetch(info.url)).status).toBe(404)
  })
})

it('caption preview shares owner limits and cleanup; both wrapper and composition are transparent', async () => {
  const previews = service()
  const params = {
    width: 1280,
    height: 720,
    duration: 2,
    cues: [{ start: 0.25, end: 1.75, text: '字幕 fetch(1) / url(1)' }],
  }
  const info = await previews.openCaptions('owner', params, 'http://localhost:5173')
  expect(info).toMatchObject({ width: 1280, height: 720, duration: 2 })
  const wrapper = await (await fetch(info.url)).text()
  expect(wrapper).toContain('background:transparent')
  expect(wrapper).toContain('e.source!==parent')
  expect(wrapper).toContain('e.origin!==config.origin')
  const html = await (await fetch(new URL('composition.html', info.url))).text()
  expect(html).toContain('background:transparent')
  expect(html).toContain('字幕 fetch(1) / url(1)')
  for (let i = 0; i < 11; i++) await previews.openCaptions('owner', params, 'http://localhost:5173')
  await expect(previews.open('owner', {}, {}, 'http://localhost:5173')).rejects.toThrow('过多')
  expect(previews.release('other-owner', info.id)).toBe(false)
  expect(previews.release('owner', info.id)).toBe(true)
  expect((await fetch(info.url)).status).toBe(404)
  await previews.close()
  await expect(previews.openCaptions('owner', params, 'http://localhost:5173')).rejects.toThrow(
    '已关闭',
  )
})
