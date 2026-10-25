import { describe, expect, it } from 'vite-plus/test'
import { fakeContext } from '../testing'
import { arkProvider } from './index'
import { referenceUploader } from './reference-upload'

const video = { assetId: 'local', kind: 'video' as const }
const file = { data: new Uint8Array([1, 2, 3]), mime: 'video/mp4' }
const setup = (replies: unknown[] = []) => {
  const f = fakeContext(arkProvider, replies)
  f.ctx.settings.referenceBucket = 'test-bucket'
  f.ctx.secret = (name) =>
    (
      {
        ARK_TOS_ACCESS_KEY: 'test-ak',
        ARK_TOS_SECRET_KEY: 'test-sk',
        ARK_API_KEY: 'ark-key',
      } as Record<string, string>
    )[name]
  return f
}
describe('TOS 私有视频参考上传', () => {
  it('官方 SDK 签名，宿主 PUT 原件，GET 限时七天，不发送 Ark API Key', async () => {
    const f = setup([new Response(null, { status: 200 })])
    const url = new URL(await referenceUploader(f.ctx)(video, file))
    const [put, init] = f.fetch.mock.calls[0]!
    const upload = new URL(String(put))
    expect(upload.hostname).toBe('test-bucket.tos-cn-beijing.volces.com')
    expect(upload.pathname).toMatch(/^\/plein\/video-references\/[a-f0-9]{64}\.mp4$/)
    expect(init).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4' },
      body: file.data,
      signal: f.ctx.signal,
    })
    expect(upload.searchParams.get('X-Tos-Expires')).toBe('900')
    expect(url.pathname).toBe(upload.pathname)
    expect(url.searchParams.get('X-Tos-Expires')).toBe('604800')
    expect(url.searchParams.get('X-Tos-Signature')).not.toBe(
      upload.searchParams.get('X-Tos-Signature'),
    )
    expect(String(put)).not.toContain('ark-key')
    expect(f.ctx.log).not.toHaveBeenCalled()
  })
  it('上传失败不会泄露签名和密钥，也不标成生成提交未知', async () => {
    for (const reply of [
      new Response('secret body', { status: 403 }),
      new Error('signed-url-secret'),
    ]) {
      const f = setup([reply])
      try {
        await referenceUploader(f.ctx)(video, file)
        expect.fail('should reject')
      } catch (error) {
        expect(error).toMatchObject({ outcome: undefined, cause: undefined })
        expect(String(error)).toContain('尚未提交视频生成')
        expect(String(error)).not.toMatch(/secret|test-sk|X-Tos/)
      }
      expect(f.fetch).toHaveBeenCalledOnce()
    }
  })
})
