import { API, MediaDeriveRequest, type SubtitleFontInfo } from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import { DeriveError, deriveAsset } from '../assets/derive'
import { subtitleFont } from '../assets/fonts'
import { mediaCaps } from '../assets/media'
import { type AssetStore, UploadTooLargeError } from '../assets/store'
import { sendFile } from './files'

const notFound = { error: 'not_found', message: '资产不存在' }

/** 加工失败的原因 → 状态码：参数问题 400，类型不匹配 / 能力缺失 422，没有 ffmpeg 503 */
function statusOf(code: DeriveError['code']) {
  if (code === 'not_found') return 404
  if (code === 'invalid') return 400
  if (code === 'no_ffmpeg') return 503
  return 422
}

/**
 * 媒体加工接口：裁剪 / 旋转 / 镜像（sharp）、截取 / 变速 / 切分 / 音视频分离 / 抽帧（ffmpeg）。
 * 前端工具条与智能体工具走的是同一个加工函数，这里只是它的入口。
 */
export function mediaRoutes(store: AssetStore) {
  return (
    new Hono<AuthEnv>()
      .get(API.mediaCaps, async (c) => c.json(await mediaCaps()))
      .get(API.subtitleFont, async (c) => {
        const font = await subtitleFont()
        if (!font) return c.json({ error: 'not_found', message: '没有找到字幕字体' }, 404)
        const info: SubtitleFontInfo = {
          family: font.family,
          version: `${Math.round(font.mtime)}-${font.size}`,
        }
        return c.json(info)
      })
      // 地址里带着 version，文件换了地址就变，可以长期缓存
      .get(`${API.subtitleFont}/file`, async (c) => {
        const font = await subtitleFont()
        if (!font) return c.json({ error: 'not_found', message: '没有找到字幕字体' }, 404)
        return sendFile(c, font.file, { mime: 'font/otf', immutable: true })
      })
      .post(API.mediaDerive, async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = MediaDeriveRequest.safeParse(body)
        if (!parsed.success)
          return c.json(
            {
              error: 'invalid',
              message: parsed.error.issues[0]
                ? `${parsed.error.issues[0].path.join('.') || '参数'}：${parsed.error.issues[0].message}`
                : '参数不合法',
            },
            400,
          )
        if (!store.get(c.var.principal.id, parsed.data.assetId)) return c.json(notFound, 404)
        try {
          const made = await deriveAsset(store, c.var.principal.id, parsed.data)
          return c.json(made, 201)
        } catch (err) {
          if (err instanceof DeriveError)
            return c.json({ error: err.code, message: err.message }, statusOf(err.code))
          // 比如 0.25 倍速把大视频拉得更长，产物超过上传上限
          if (err instanceof UploadTooLargeError)
            return c.json({ error: 'too_large', message: `加工结果${err.message}` }, 413)
          console.error('[media] 加工失败：', err)
          return c.json({ error: 'internal', message: '加工失败，请查看服务端日志' }, 500)
        }
      })
  )
}
