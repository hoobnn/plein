import {
  API,
  type Asset,
  type AssetVariant,
  type Canvas,
  type Catalog,
  type ProviderConfigUpdate,
  type ProviderConfigView,
  type ProviderTestResult,
  type SessionInfo,
  type UserTemplate,
} from '@plein/protocol'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** 401 时通知外壳回到登录页 */
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string
      message?: string
      code?: string
    } | null
    if (res.status === 401 && !path.startsWith(API.auth)) onUnauthorized?.()
    throw new ApiError(
      res.status,
      body?.error ?? body?.code ?? 'http_error',
      body?.message ?? res.statusText,
    )
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

export const api = {
  session: () => request<SessionInfo>(API.session),
  /** 首次创建所有者账号（Better Auth 注册，成功后即登录） */
  setup: (input: { name: string; email: string; password: string }) =>
    request(`${API.auth}/sign-up/email`, json('POST', input)),
  login: (input: { email: string; password: string }) =>
    request(`${API.auth}/sign-in/email`, json('POST', input)),
  logout: () => request(`${API.auth}/sign-out`, json('POST', {})),

  canvases: () => request<Canvas[]>(API.canvases),
  createCanvas: (title?: string) =>
    request<Canvas>(API.canvases, json('POST', title ? { title } : {})),
  canvas: (id: string) => request<Canvas>(API.canvas(id)),
  renameCanvas: (id: string, title: string) =>
    request<Canvas>(API.canvas(id), json('PATCH', { title })),
  deleteCanvas: (id: string) => request<void>(API.canvas(id), { method: 'DELETE' }),
  templates: () => request<UserTemplate[]>(API.templates),
  /** data 是 ClipboardData（Frame 及其内容），服务端按 TemplateData 校验 */
  saveTemplate: (title: string, data: object) =>
    request<UserTemplate>(API.templates, json('POST', { title, data })),
  deleteTemplate: (id: string) => request<void>(API.template(id), { method: 'DELETE' }),

  catalog: () => request<Catalog>(API.catalog),
  providerConfig: (id: string) => request<ProviderConfigView>(API.providerConfig(id)),
  updateProviderConfig: (id: string, body: ProviderConfigUpdate) =>
    request<ProviderConfigView>(API.providerConfig(id), json('PUT', body)),
  testProvider: (id: string) => request<ProviderTestResult>(API.providerTest(id), json('POST', {})),

  upload: (file: File) =>
    request<Asset>(API.assets, {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-file-name': encodeURIComponent(file.name),
      },
      body: file,
    }),
}

export const assetUrls = {
  original: (id: string) => API.asset(id),
  variant: (id: string, v: AssetVariant) => API.assetVariant(id, v),
}

/** 同步地址：与页面同源（开发时经 Vite 代理） */
export function syncUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${API.sync}`
}
