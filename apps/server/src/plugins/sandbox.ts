import { domainAllowed, type PluginManifest } from '@plein/plugin-sdk'

export class PermissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermissionError'
  }
}

const MAX_REDIRECTS = 5

/**
 * 按清单 permissions.network 裁剪的 fetch：只能访问声明过的域名，重定向也逐跳检查。
 * 内置插件与宿主同进程，这层是约定而非安全边界；第三方插件以后在子进程里运行，
 * 由宿主代理网络请求，用的是同一套检查。
 */
export function scopedFetch(manifest: PluginManifest, base: typeof fetch = fetch): typeof fetch {
  const allowed = manifest.permissions.network
  const check = (url: URL) => {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new PermissionError(`插件 ${manifest.id} 不能访问 ${url.protocol} 地址`)
    }
    if (!domainAllowed(allowed, url.hostname)) {
      throw new PermissionError(`插件 ${manifest.id} 没有声明访问 ${url.hostname} 的权限`)
    }
  }
  const scoped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let request = new Request(input, init)
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      check(new URL(request.url))
      const res = await base(request, { redirect: 'manual' })
      const location = res.headers.get('location')
      if (res.status < 300 || res.status >= 400 || !location) return res
      const next = new URL(location, request.url)
      // 303 以及 301/302 的非 GET 请求按浏览器行为改成 GET
      const toGet =
        res.status === 303 ||
        ((res.status === 301 || res.status === 302) && request.method === 'POST')
      request = new Request(
        next,
        toGet ? { method: 'GET', headers: request.headers, signal: request.signal } : request,
      )
    }
    throw new PermissionError(`重定向次数过多：${request.url}`)
  }
  return scoped as typeof fetch
}

/** 按清单 permissions.secrets 裁剪的密钥读取 */
export function scopedSecrets(manifest: PluginManifest, values: Record<string, string>) {
  const allowed = new Set(manifest.permissions.secrets)
  return (name: string) => {
    if (!allowed.has(name)) throw new PermissionError(`插件 ${manifest.id} 没有声明密钥 ${name}`)
    return values[name] || undefined
  }
}
