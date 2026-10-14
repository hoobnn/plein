import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { ComposeSpec } from '@plein/plugin-sdk'
import {
  API,
  MediaDeriveRequest,
  SequenceExportRequest,
  type SubtitleFontInfo,
} from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import { DeriveError, deriveAsset } from '../assets/derive'
import { subtitleFont } from '../assets/fonts'
import { sequencePackage } from '../assets/interchange'
import { mediaCaps } from '../assets/media'
import { type AssetStore, UploadTooLargeError } from '../assets/store'
import { sendFile } from '../http/files'

const notFound = { error: 'not_found', message: '资产不存在' }

/** 剪辑工程导出：先 POST 合成参数换一个短期地址，再用普通链接下载（浏览器、桌面端的另存为都能接住） */
const EXPORT_TTL = 10 * 60_000
const pendingExports = new Map<string, { owner: string; spec: ComposeSpec; expires: number }>()

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
      .post(API.sequenceExport, async (c) => {
        const parsed = SequenceExportRequest.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'invalid', message: '参数不合法' }, 400)
        const owner = c.var.principal.id
        const spec = parsed.data.spec as ComposeSpec
        const refs = [...spec.clips.map((x) => x.asset), ...spec.audio.map((x) => x.asset)]
        if (refs.some((r) => !store.get(owner, r.assetId))) return c.json(notFound, 404)
        const now = Date.now()
        for (const [k, v] of pendingExports) if (v.expires < now) pendingExports.delete(k)
        const token = randomUUID()
        pendingExports.set(token, { owner, spec, expires: now + EXPORT_TTL })
        return c.json({ url: API.sequenceExportFile(token) }, 201)
      })
      .get(`${API.sequenceExport}/:token`, async (c) => {
        const job = pendingExports.get(c.req.param('token'))
        if (!job || job.expires < Date.now() || job.owner !== c.var.principal.id)
          return c.json({ error: 'not_found', message: '导出链接已过期，请重新导出' }, 404)
        try {
          const { stream, name } = await sequencePackage(store, job.owner, job.spec)
          return new Response(Readable.toWeb(stream) as ReadableStream, {
            headers: {
              'Content-Type': 'application/zip',
              // 带一个 ASCII 的 filename 兜底，不认 filename* 的客户端也能拿到 .zip 后缀
              'Content-Disposition': `attachment; filename="sequence.zip"; filename*=UTF-8''${encodeURIComponent(`${name}.zip`)}`,
              'Cache-Control': 'no-store',
            },
          })
        } catch (err) {
          if ((err as { code?: string }).code === 'not_found') return c.json(notFound, 404)
          console.error('[media] 导出剪辑工程失败：', err)
          return c.json({ error: 'internal', message: '导出失败，请查看服务端日志' }, 500)
        }
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
