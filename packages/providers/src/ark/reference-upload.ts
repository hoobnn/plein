import { createHash, createHmac } from 'node:crypto'
import { TosClient } from '@volcengine/tos-sdk'
import { type AssetRef, type ProviderContext, ProviderError } from '@plein/plugin-sdk'

export interface ReferenceStorage {
  referenceStorage: 'tos' | 'oss' | 'cos' | 's3'
  referenceEndpoint: string
  referencePathStyle: boolean
  referenceBucket: string
  referenceRegion: string
}

type Upload = (
  ref: AssetRef,
  file: Awaited<ReturnType<ProviderContext['files']['read']>>,
) => Promise<string>

const PUT_EXPIRES = 900
// 覆盖离线任务的排队窗口，源桶保持私有；也是 SigV4 预签名的上限
const GET_EXPIRES = 7 * 24 * 60 * 60

// 云厂商的 S3 兼容地址由地域拼出，固定虚拟主机风格
const CLOUD_ENDPOINTS: Partial<
  Record<ReferenceStorage['referenceStorage'], (region: string) => string>
> = {
  oss: (region) => `https://s3.oss-${region}.aliyuncs.com`,
  cos: (region) => `https://cos.${region}.myqcloud.com`,
}

/** S3 兼容存储的上传地址：虚拟主机风格把桶名放进域名，路径风格放进路径 */
function s3Target(storage: ReferenceStorage) {
  const region = storage.referenceRegion.trim()
  const cloud = CLOUD_ENDPOINTS[storage.referenceStorage]
  if (cloud && !/^[a-z]{2}(?:-[a-z0-9]+)+$/.test(region)) return undefined
  let endpoint: URL
  try {
    endpoint = new URL(cloud ? cloud(region) : storage.referenceEndpoint.trim())
  } catch {
    return undefined
  }
  const bucket = storage.referenceBucket.trim()
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/' ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
  )
    return undefined
  return storage.referencePathStyle && !cloud
    ? { host: endpoint.host, prefix: `/${bucket}` }
    : { host: `${bucket}.${endpoint.host}`, prefix: '' }
}

/** 宿主据此额外放行上传用的那一个域名；选 TOS 时不放行任何额外域名 */
export function referenceStorageHost(settings: Record<string, unknown>): string | undefined {
  const storage = settings.referenceStorage
  if (storage !== 'oss' && storage !== 'cos' && storage !== 's3') return undefined
  const target = s3Target({
    referenceStorage: storage,
    referenceEndpoint: String(settings.referenceEndpoint ?? ''),
    referencePathStyle: settings.referencePathStyle === true,
    referenceBucket: String(settings.referenceBucket ?? ''),
    referenceRegion: String(settings.referenceRegion ?? ''),
  })
  return target && new URL(`https://${target.host}`).hostname
}

const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )

/** AWS SigV4 查询串预签名，只签 host，负载为 UNSIGNED-PAYLOAD；query 为额外一并签名的查询参数 */
export function presignS3(opts: {
  method: 'PUT' | 'GET'
  host: string
  path: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  expires: number
  now: Date
  query?: Record<string, string>
}) {
  const stamp = opts.now.toISOString().replace(/[-:]|\.\d{3}/g, '')
  const day = stamp.slice(0, 8)
  const scope = `${day}/${opts.region}/s3/aws4_request`
  const query = Object.entries({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD',
    'X-Amz-Credential': `${opts.accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(opts.expires),
    'X-Amz-SignedHeaders': 'host',
    ...opts.query,
  })
    .map(([k, v]) => `${encode(k)}=${encode(v)}`)
    .sort()
    .join('&')
  const path = opts.path.split('/').map(encode).join('/')
  const request = [
    opts.method,
    path,
    query,
    `host:${opts.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const toSign = [
    'AWS4-HMAC-SHA256',
    stamp,
    scope,
    createHash('sha256').update(request).digest('hex'),
  ].join('\n')
  let key: Buffer = createHmac('sha256', `AWS4${opts.secretAccessKey}`).update(day).digest()
  for (const part of [opts.region, 's3', 'aws4_request'])
    key = createHmac('sha256', key).update(part).digest()
  const signature = createHmac('sha256', key).update(toSign).digest('hex')
  return `https://${opts.host}${path}?${query}&X-Amz-Signature=${signature}`
}

function objectKey(file: Awaited<ReturnType<ProviderContext['files']['read']>>) {
  const hash = createHash('sha256').update(file.data).digest('hex')
  return `plein/video-references/${hash}.${file.mime === 'video/quicktime' ? 'mov' : 'mp4'}`
}

/** 上传失败一律在提交生成前报错；不把带签名的 URL / 密钥带入日志、任务回执或错误 cause */
async function put(
  ctx: ProviderContext<ReferenceStorage>,
  label: string,
  url: string,
  file: Awaited<ReturnType<ProviderContext['files']['read']>>,
  headers: Record<string, string> = {},
) {
  try {
    const response = await ctx.fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': file.mime, ...headers },
      body: new Uint8Array(file.data),
      signal: ctx.signal,
    })
    if (!response.ok)
      throw new ProviderError(
        response.status === 403 ? 'auth' : 'unavailable',
        `${label} 参考视频上传失败（HTTP ${response.status}）；尚未提交视频生成`,
      )
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw new ProviderError(
      ctx.signal.aborted ? 'cancelled' : 'unavailable',
      `${label} 参考视频上传未完成；尚未提交视频生成`,
    )
  }
}

/** 走 SDK 的 Node 入口：浏览器入口深引用 axios 内部模块（axios/lib/core/createError 等），带漏洞修复的 axios 已删除这些模块，改用公开 API 即可；SDK 只在本地签名，所有网络请求仍走宿主的权限、取消与网络代理。 */
function tosUploader(ctx: ProviderContext<ReferenceStorage>, bucket: string, region: string) {
  const accessKeyId = ctx.secret('ARK_TOS_ACCESS_KEY')!
  const accessKeySecret = ctx.secret('ARK_TOS_SECRET_KEY')!
  if (
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
    !/^[a-z]{2}-[a-z]+(?:-[a-z0-9]+)*$/.test(region)
  )
    throw new ProviderError('invalid_input', 'TOS 桶名称或地域格式不正确')
  const client = new TosClient({
    bucket,
    region,
    endpoint: `tos-${region}.volces.com`,
    accessKeyId,
    accessKeySecret,
    secure: true,
  })
  return async (_ref: AssetRef, file: Awaited<ReturnType<ProviderContext['files']['read']>>) => {
    const key = objectKey(file)
    let url: string
    try {
      url = client.getPreSignedUrl({ key, method: 'PUT', expires: PUT_EXPIRES })
    } catch {
      throw new ProviderError('invalid_input', 'TOS 参考视频签名失败；尚未提交视频生成')
    }
    await put(ctx, 'TOS', url, file)
    return client.getPreSignedUrl({ key, method: 'GET', expires: GET_EXPIRES })
  }
}

function s3Uploader(ctx: ProviderContext<ReferenceStorage>, region: string) {
  const target = s3Target(ctx.settings)
  if (!target)
    throw new ProviderError(
      'invalid_input',
      ctx.settings.referenceStorage === 's3'
        ? 'S3 兼容存储地址须为不带路径的 https 地址，桶名须为小写字母、数字、点或连字符'
        : '存储地域或桶名格式不正确：地域如 cn-hangzhou / ap-guangzhou，桶名为小写字母、数字、点或连字符',
    )
  const sign = (method: 'PUT' | 'GET', path: string, expires: number) =>
    presignS3({
      method,
      host: target.host,
      path,
      region,
      accessKeyId: ctx.secret('ARK_TOS_ACCESS_KEY')!,
      secretAccessKey: ctx.secret('ARK_TOS_SECRET_KEY')!,
      expires,
      now: new Date(),
    })
  return async (_ref: AssetRef, file: Awaited<ReturnType<ProviderContext['files']['read']>>) => {
    const path = `${target.prefix}/${objectKey(file)}`
    // 阿里云 OSS 的 S3 兼容 V4 请求要求声明不签负载；其他 S3 兼容存储也接受
    await put(ctx, 'S3 兼容存储', sign('PUT', path, PUT_EXPIRES), file, {
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
    })
    return sign('GET', path, GET_EXPIRES)
  }
}

export function referenceUploader(ctx: ProviderContext<ReferenceStorage>): Upload {
  const bucket = ctx.settings.referenceBucket.trim()
  const region = ctx.settings.referenceRegion.trim()
  const storage = ctx.settings.referenceStorage
  if (
    !bucket ||
    !region ||
    (storage === 's3' && !ctx.settings.referenceEndpoint.trim()) ||
    !ctx.secret('ARK_TOS_ACCESS_KEY') ||
    !ctx.secret('ARK_TOS_SECRET_KEY')
  )
    throw new ProviderError(
      'invalid_input',
      storage === 's3'
        ? '火山视频参考需要在模型平台设置中配置 S3 兼容存储地址、桶、地域和存储 Access Key / Secret Key'
        : '火山视频参考需要在模型平台设置中配置存储桶、地域和存储 Access Key / Secret Key',
    )
  return storage === 'tos' ? tosUploader(ctx, bucket, region) : s3Uploader(ctx, region)
}
