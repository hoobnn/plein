import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import {
  MotionParams,
  motionHtml,
  motionSize,
  motionDurationFrames,
  CaptionLayerParams,
  captionLayerHtml,
  captionDurationFrames,
} from '@plein/nodes'
import type { AssetStore } from '../assets/store'
import { sendFile } from '../http/files'
import { motionRuntimeAssets } from './runtime'
import { assertLocalMotionHtml } from './security'

const TTL = 10 * 60_000
interface PreviewSession {
  owner: string
  nonce: string
  expiresAt: number
  parentOrigin: string
  origin: string
  html: string
  files: Map<string, { path: string; mime: string }>
}
export interface MotionPreviewInfo {
  id: string
  url: string
  origin: string
  nonce: string
  expiresAt: number
  width: number
  height: number
  duration: number
}

/** 合成在独立origin播放；此服务器没有主应用API、Cookie鉴权或Provider凭据。 */
export class MotionPreviews {
  private sessions = new Map<string, PreviewSession>()
  private server?: ServerType
  private starting?: Promise<string>
  private closed = false
  constructor(private store: AssetStore) {}

  async open(
    owner: string,
    value: unknown,
    inputs: { image?: string; video?: string },
    parentOrigin: string,
  ): Promise<MotionPreviewInfo> {
    if (this.closed) throw new Error('动态合成预览服务已关闭')
    const params = MotionParams.parse(value)
    const files = new Map<string, { path: string; mime: string }>()
    const media: { image?: string; video?: string } = {}
    for (const kind of ['image', 'video'] as const) {
      const id = inputs[kind]
      if (!id) continue
      const asset = this.store.get(owner, id)
      if (!asset || asset.kind !== kind) throw new Error('预览素材不存在或类型不正确')
      const name = `media/${kind}`
      files.set(name, { path: this.store.originalPath(id), mime: asset.mime })
      media[kind] = name
    }
    return this.openDocument(
      owner,
      motionHtml(params, {
        ...media,
        gsap: 'vendor/gsap.min.js',
        fontCss: 'fonts/noto-sans-sc.css',
      }),
      { ...motionSize(params), duration: motionDurationFrames(params) / 30 },
      parentOrigin,
      files,
    )
  }

  async openCaptions(
    owner: string,
    value: unknown,
    parentOrigin: string,
  ): Promise<MotionPreviewInfo> {
    const params = CaptionLayerParams.parse(value)
    return this.openDocument(
      owner,
      captionLayerHtml(params),
      { width: params.width, height: params.height, duration: captionDurationFrames(params) / 30 },
      parentOrigin,
      new Map(),
    )
  }

  private async openDocument(
    owner: string,
    html: string,
    dimensions: { width: number; height: number; duration: number },
    parentOrigin: string,
    files: Map<string, { path: string; mime: string }>,
  ): Promise<MotionPreviewInfo> {
    if (this.closed) throw new Error('动态合成预览服务已关闭')
    const parent = new URL(parentOrigin)
    if (!['http:', 'https:'].includes(parent.protocol) || parent.origin !== parentOrigin)
      throw new Error('动态合成预览需要明确的父页面 origin')
    assertLocalMotionHtml(html)
    const runtime = await motionRuntimeAssets()
    files.set('vendor/gsap.min.js', { path: runtime.gsapPath, mime: 'text/javascript' })
    for (const file of runtime.files)
      files.set(file.path, {
        path: file.sourcePath,
        mime: file.path.endsWith('.woff2') ? 'font/woff2' : 'text/plain',
      })
    const require = createRequire(import.meta.url)
    const producerRequire = createRequire(import.meta.resolve('@hyperframes/producer'))
    files.set('runtime.js', {
      path: producerRequire.resolve('@hyperframes/core/runtime'),
      mime: 'text/javascript',
    })
    files.set('player.js', {
      path: join(dirname(require.resolve('@hyperframes/player')), 'hyperframes-player.global.js'),
      mime: 'text/javascript',
    })
    if (this.closed) throw new Error('动态合成预览服务已关闭')
    const serverOrigin = await this.start()
    const port = new URL(serverOrigin).port
    const origin = `http://${parent.hostname === 'localhost' ? '127.0.0.1' : 'localhost'}:${port}`
    if (this.closed) throw new Error('动态合成预览服务已关闭')
    const id = randomUUID(),
      nonce = randomUUID(),
      expiresAt = Date.now() + TTL
    for (const [key, session] of this.sessions)
      if (session.expiresAt <= Date.now()) this.sessions.delete(key)
    if ([...this.sessions.values()].filter((s) => s.owner === owner).length >= 12)
      throw new Error('打开的动态合成预览过多，请关闭不用的面板')
    // CSS是安装包内的固定资源，保存在这个会话中而不是写入主应用文档。
    files.set('fonts/noto-sans-sc.css', { path: '', mime: runtime.fontCss })
    this.sessions.set(id, { owner, nonce, expiresAt, parentOrigin, origin, html, files })
    return {
      id,
      nonce,
      expiresAt,
      origin,
      url: `${origin}/s/${id}/`,
      ...dimensions,
    }
  }

  release(owner: string, id: string): boolean {
    if (this.sessions.get(id)?.owner !== owner) return false
    return this.sessions.delete(id)
  }

  async close(): Promise<void> {
    this.closed = true
    this.sessions.clear()
    const server = this.server
    this.server = undefined
    this.starting = undefined
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // Stop accepting first, then close all active streams/keepalive sockets.
        if ('closeAllConnections' in server) server.closeAllConnections()
      })
    }
  }

  private start(): Promise<string> {
    if (this.closed) return Promise.reject(new Error('动态合成预览服务已关闭'))
    if (this.starting) return this.starting
    this.starting = new Promise((resolve, reject) => {
      const app = new Hono()
      app.use('*', async (c, next) => {
        const host = c.req.header('host') ?? ''
        if (!/^(?:localhost|127\.0\.0\.1):\d+$/.test(host)) return c.text('Not found', 404)
        c.header('Cache-Control', 'no-store')
        c.header('X-Content-Type-Options', 'nosniff')
        c.header('Referrer-Policy', 'no-referrer')
        c.header(
          'Content-Security-Policy',
          "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; frame-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'",
        )
        await next()
      })
      app.get('/s/:id/*', async (c) => {
        const id = c.req.param('id'),
          session = this.sessions.get(id)
        if (
          !session ||
          session.origin !== new URL(c.req.url).origin ||
          session.expiresAt <= Date.now()
        ) {
          if (session && session.expiresAt <= Date.now()) this.sessions.delete(id)
          return c.text('Preview expired', 404)
        }
        const path = c.req.path.slice(`/s/${id}/`.length)
        if (path === '') return c.html(previewPage(id, session))
        if (path === 'composition.html') return c.html(session.html)
        const file = session.files.get(path)
        if (!file) return c.text('Not found', 404)
        if (path === 'fonts/noto-sans-sc.css')
          return c.body(file.mime, 200, { 'Content-Type': 'text/css' })
        if (file.mime === 'text/javascript')
          return c.body(await readFile(file.path, 'utf8'), 200, { 'Content-Type': file.mime })
        if (file.mime.startsWith('font/'))
          return new Response(await readFile(file.path), {
            headers: { 'Content-Type': file.mime, 'Cache-Control': 'no-store' },
          })
        return sendFile(c, file.path, { mime: file.mime })
      })
      this.server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) =>
        resolve(`http://localhost:${info.port}`),
      )
      const server = this.server
      server.once('error', (error) => {
        if (this.server === server) {
          this.server = undefined
          this.starting = undefined
        }
        reject(error)
      })
    })
    return this.starting
  }
}

function previewPage(id: string, session: PreviewSession): string {
  const config = JSON.stringify({
    id,
    nonce: session.nonce,
    origin: session.parentOrigin,
  }).replaceAll('<', '\\u003c')
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}hyperframes-player{width:100%;height:100%;display:block;background:transparent!important}</style><script src="player.js"></script></head><body><hyperframes-player src="composition.html" runtime-src="runtime.js" disable-click-to-play></hyperframes-player><script>
const config=${config};const player=document.querySelector('hyperframes-player');
const emit=(event,detail={})=>parent.postMessage({type:'plein-motion-event',id:config.id,nonce:config.nonce,event,...detail},config.origin);
for(const event of ['ready','timeupdate','play','pause','ended'])player.addEventListener(event,e=>emit(event,{time:player.currentTime,duration:player.duration}));
player.addEventListener('error',e=>emit('error',{message:e.detail?.message||'动态合成预览加载失败'}));
player.addEventListener('playbackerror',()=>emit('error',{message:'浏览器未允许播放，请再次点击播放'}));
addEventListener('message',e=>{const m=e.data;if(e.source!==parent||e.origin!==config.origin||!m||m.type!=='plein-motion-command'||m.id!==config.id||m.nonce!==config.nonce)return;
if(m.command==='play')player.play();if(m.command==='pause')player.pause();if(m.command==='seek'&&Number.isFinite(m.time))player.seek(Math.max(0,Math.min(player.duration||0,m.time)));if(m.command==='dispose'){player.pause();player.stopMedia?.();player.remove();}});
</script></body></html>`
}
