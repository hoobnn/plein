import { createHash } from 'node:crypto'
import { TosClient } from '@volcengine/tos-sdk'
import { type AssetRef, type ProviderContext, ProviderError } from '@plein/plugin-sdk'

export interface ReferenceStorage {
  referenceBucket: string
  referenceRegion: string
}

/** 走 SDK 的 Node 入口：浏览器入口深引用 axios 内部模块（axios/lib/core/createError 等），带漏洞修复的 axios 已删除这些模块，改用公开 API 即可；SDK 只在本地签名，所有网络请求仍走宿主的权限、取消与网络代理。 */
export function referenceUploader(ctx: ProviderContext<ReferenceStorage>) {
  const bucket = ctx.settings.referenceBucket.trim()
  const region = ctx.settings.referenceRegion.trim()
  const accessKeyId = ctx.secret('ARK_TOS_ACCESS_KEY')
  const accessKeySecret = ctx.secret('ARK_TOS_SECRET_KEY')
  if (!bucket || !region || !accessKeyId || !accessKeySecret)
    throw new ProviderError(
      'invalid_input',
      '火山视频参考需要在模型平台设置中配置 TOS 桶、地域和 TOS Access Key / Secret Key',
    )
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
    const hash = createHash('sha256').update(file.data).digest('hex')
    const key = `plein/video-references/${hash}.${file.mime === 'video/quicktime' ? 'mov' : 'mp4'}`
    try {
      const response = await ctx.fetch(
        client.getPreSignedUrl({ key, method: 'PUT', expires: 900 }),
        {
          method: 'PUT',
          headers: { 'Content-Type': file.mime },
          body: new Uint8Array(file.data),
          signal: ctx.signal,
        },
      )
      if (!response.ok)
        throw new ProviderError(
          response.status === 403 ? 'auth' : 'unavailable',
          `TOS 参考视频上传失败（HTTP ${response.status}）；尚未提交视频生成`,
        )
      // 覆盖离线任务的排队窗口，源桶保持私有。
      return client.getPreSignedUrl({ key, method: 'GET', expires: 7 * 24 * 60 * 60 })
    } catch (error) {
      if (error instanceof ProviderError) throw error
      // 不将带签名的 URL / 密钥带入日志、任务回执或错误 cause。
      throw new ProviderError(
        ctx.signal.aborted ? 'cancelled' : 'unavailable',
        'TOS 参考视频上传未完成；尚未提交视频生成',
      )
    }
  }
}
