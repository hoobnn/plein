import { describe, expect, it } from 'vite-plus/test'
import { fakeContext } from '../testing'
import { arkProvider } from './index'
import { presignS3, referenceStorageHost, referenceUploader } from './reference-upload'

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
        expect(String(error)).not.toMatch(/secret|test-sk|X-Tos|X-Amz/)
      }
      expect(f.fetch).toHaveBeenCalledOnce()
    }
  })
})

describe('S3 兼容存储（阿里云 OSS / MinIO）', () => {
  // 期望签名由官方 @aws-sdk/s3-request-presigner 生成（同一时刻、密钥与对象，含 SDK 的 x-id 参数）
  const key = `plein/video-references/${'a'.repeat(64)}.mp4`
  const base = {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    now: new Date('2026-10-29T03:04:05Z'),
  }
  it.each([
    [
      'PUT',
      'plein-refs.s3.oss-cn-hangzhou.aliyuncs.com',
      `/${key}`,
      'cn-hangzhou',
      900,
      'PutObject',
      '347c422e27d3c1697c2410de7ced524730e41470fafb7c540d1013a8952ef838',
    ],
    [
      'GET',
      'plein-refs.s3.oss-cn-hangzhou.aliyuncs.com',
      `/${key}`,
      'cn-hangzhou',
      604800,
      'GetObject',
      '4c46ff1d7ffc6d623e70a771433e91778f532df423195b1137dd38eb391b5f9c',
    ],
    [
      'PUT',
      'minio.example.com:9000',
      `/plein-refs/${key}`,
      'us-east-1',
      900,
      'PutObject',
      '46e6324fd608cab6766b7c5d4d210741b977f72537dfa87affed74c5d4d66d26',
    ],
    [
      'GET',
      'minio.example.com:9000',
      `/plein-refs/${key}`,
      'us-east-1',
      604800,
      'GetObject',
      '98dc6cb8621034a69fc075a6e0970a5f8cb3ef817c3d3187fa4268aaf08d5d5c',
    ],
  ] as const)(
    '%s %s 的 SigV4 预签名与 AWS SDK 一致',
    (method, host, path, region, expires, id, signature) => {
      const url = new URL(
        presignS3({ ...base, method, host, path, region, expires, query: { 'x-id': id } }),
      )
      expect(url.host).toBe(host)
      expect(url.pathname).toBe(path)
      expect(url.searchParams.get('X-Amz-Signature')).toBe(signature)
    },
  )

  const s3 = (settings: Record<string, unknown>, replies: unknown[] = []) => {
    const f = setup(replies)
    Object.assign(f.ctx.settings, {
      referenceStorage: 's3',
      referenceBucket: 'plein-refs',
      ...settings,
    })
    return f
  }

  it('OSS 虚拟主机风格：PUT 声明不签负载，返回七天 GET 链接', async () => {
    const f = s3(
      {
        referenceEndpoint: 'https://s3.oss-cn-hangzhou.aliyuncs.com',
        referenceRegion: 'cn-hangzhou',
      },
      [new Response(null, { status: 200 })],
    )
    const url = new URL(await referenceUploader(f.ctx)(video, file))
    const [put, init] = f.fetch.mock.calls[0]!
    const upload = new URL(String(put))
    expect(upload.hostname).toBe('plein-refs.s3.oss-cn-hangzhou.aliyuncs.com')
    expect(upload.pathname).toMatch(/^\/plein\/video-references\/[a-f0-9]{64}\.mp4$/)
    expect(upload.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(upload.searchParams.get('X-Amz-Credential')).toBe(
      `test-ak/${upload.searchParams.get('X-Amz-Date')!.slice(0, 8)}/cn-hangzhou/s3/aws4_request`,
    )
    expect(init).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4', 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
      body: file.data,
    })
    expect(url.pathname).toBe(upload.pathname)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('604800')
    expect(String(put)).not.toMatch(/ark-key|test-sk/)
  })

  it('MinIO 路径风格：桶名在路径里，保留端口', async () => {
    const f = s3(
      {
        referenceEndpoint: 'https://minio.example.com:9000',
        referencePathStyle: true,
        referenceRegion: 'us-east-1',
      },
      [new Response(null, { status: 200 })],
    )
    await referenceUploader(f.ctx)(video, file)
    const upload = new URL(String(f.fetch.mock.calls[0]![0]))
    expect(upload.host).toBe('minio.example.com:9000')
    expect(upload.pathname).toMatch(/^\/plein-refs\/plein\/video-references\//)
  })

  it.each([
    'http://minio.example.com',
    'https://minio.example.com/base',
    'https://user:pass@minio.example.com',
    'not a url',
  ])('拒绝不安全或带路径的地址 %s，且不发请求', (endpoint) => {
    const f = s3({ referenceEndpoint: endpoint })
    expect(() => referenceUploader(f.ctx)).toThrow('https')
    expect(referenceStorageHost({ ...f.ctx.settings })).toBeUndefined()
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('上传失败不泄露签名和密钥', async () => {
    const f = s3(
      {
        referenceEndpoint: 'https://s3.oss-cn-hangzhou.aliyuncs.com',
        referenceRegion: 'cn-hangzhou',
      },
      [new Response('secret body', { status: 403 })],
    )
    const error = await referenceUploader(f.ctx)(video, file).catch((e) => e)
    expect(error).toMatchObject({ code: 'auth', cause: undefined })
    expect(String(error)).toContain('尚未提交视频生成')
    expect(String(error)).not.toMatch(/secret|test-sk|X-Amz/)
  })

  it('放行主机只算上传会用到的那一个', () => {
    const settings = {
      referenceStorage: 's3',
      referenceEndpoint: 'https://s3.oss-cn-hangzhou.aliyuncs.com',
      referenceBucket: 'plein-refs',
    }
    expect(referenceStorageHost(settings)).toBe('plein-refs.s3.oss-cn-hangzhou.aliyuncs.com')
    expect(
      referenceStorageHost({
        ...settings,
        referenceEndpoint: 'https://minio.example.com:9000',
        referencePathStyle: true,
      }),
    ).toBe('minio.example.com')
    expect(referenceStorageHost({ ...settings, referenceStorage: 'tos' })).toBeUndefined()
  })
})

describe('云厂商预设', () => {
  it.each([
    ['oss', 'cn-hangzhou', 'plein-refs', 'plein-refs.s3.oss-cn-hangzhou.aliyuncs.com'],
    [
      'cos',
      'ap-guangzhou',
      'plein-refs-1250000000',
      'plein-refs-1250000000.cos.ap-guangzhou.myqcloud.com',
    ],
  ])('%s 按地域拼出地址，固定虚拟主机风格且忽略自填地址', async (storage, region, bucket, host) => {
    const f = setup([new Response(null, { status: 200 })])
    Object.assign(f.ctx.settings, {
      referenceStorage: storage,
      referenceRegion: region,
      referenceBucket: bucket,
      referenceEndpoint: 'https://evil.example.com',
      referencePathStyle: true,
    })
    const url = new URL(await referenceUploader(f.ctx)(video, file))
    const upload = new URL(String(f.fetch.mock.calls[0]![0]))
    expect(upload.hostname).toBe(host)
    expect(upload.pathname).toMatch(/^\/plein\/video-references\//)
    expect(upload.searchParams.get('X-Amz-Credential')).toContain(`/${region}/s3/aws4_request`)
    expect(url.hostname).toBe(host)
    expect(referenceStorageHost({ ...f.ctx.settings })).toBe(host)
  })

  it('预设地域格式不对时不发请求、不放行主机', () => {
    const f = setup()
    Object.assign(f.ctx.settings, {
      referenceStorage: 'cos',
      referenceRegion: 'evil.com/x',
      referenceBucket: 'plein-refs',
    })
    expect(() => referenceUploader(f.ctx)).toThrow('地域')
    expect(referenceStorageHost({ ...f.ctx.settings })).toBeUndefined()
    expect(f.fetch).not.toHaveBeenCalled()
  })
})
