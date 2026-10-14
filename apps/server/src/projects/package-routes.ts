import { Readable } from 'node:stream'
import { API, PROJECT_PACKAGE_EXT } from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import {
  commitImport,
  discardImport,
  exportProject,
  inspectPackage,
  PackageError,
  type PackageDeps,
  packageSummary,
  PackageTooLargeError,
} from './package'

const notFound = { error: 'not_found', message: '项目不存在' }

/**
 * 项目包：导出（先看概要，再下载）与导入（上传后预检，确认后写入或放弃）。
 * 下载走普通 GET 链接，浏览器和桌面端的另存为都能接住。
 */
export function packageRoutes(deps: PackageDeps) {
  const candidates = (history: string | undefined) => (history === '1' ? 'all' : 'current')
  return new Hono<AuthEnv>()
    .get('/api/projects/:id/package/summary', async (c) => {
      const summary = await packageSummary(
        deps,
        c.var.principal.id,
        c.req.param('id'),
        candidates(c.req.query('history')),
      )
      return summary ? c.json(summary) : c.json(notFound, 404)
    })
    .get('/api/projects/:id/package', async (c) => {
      try {
        const out = await exportProject(
          deps,
          c.var.principal.id,
          c.req.param('id'),
          candidates(c.req.query('history')),
        )
        if (!out) return c.json(notFound, 404)
        const file = `${out.name}${PROJECT_PACKAGE_EXT}`
        return new Response(Readable.toWeb(out.stream) as ReadableStream, {
          headers: {
            'Content-Type': 'application/zip',
            // 带一个 ASCII 的 filename 兜底，不认 filename* 的客户端也能拿到扩展名
            'Content-Disposition': `attachment; filename="project${PROJECT_PACKAGE_EXT}"; filename*=UTF-8''${encodeURIComponent(file)}`,
            'Cache-Control': 'no-store',
          },
        })
      } catch (err) {
        if (err instanceof PackageTooLargeError)
          return c.json({ error: 'too_large', message: err.message }, 413)
        throw err
      }
    })
    .post(API.projectImports, async (c) => {
      const body = c.req.raw.body
      if (!body) return c.json({ error: 'invalid', message: '请求体为空' }, 400)
      try {
        const preview = await inspectPackage(
          deps,
          c.var.principal.id,
          Readable.fromWeb(body as never),
        )
        return c.json(preview, 201)
      } catch (err) {
        if (err instanceof PackageError)
          return c.json({ error: err.code, message: err.message }, 422)
        throw err
      }
    })
    .post('/api/project-imports/:token', async (c) => {
      const result = await commitImport(deps, c.var.principal.id, c.req.param('token'))
      if (!result)
        return c.json({ error: 'not_found', message: '导入已过期或已完成，请重新选择项目包' }, 404)
      return c.json(result, 201)
    })
    .delete('/api/project-imports/:token', async (c) => {
      await discardImport(c.var.principal.id, c.req.param('token'))
      return c.body(null, 204)
    })
}
