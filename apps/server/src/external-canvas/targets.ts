import type { ExternalPlatform, ExternalTarget } from '@plein/protocol'

const projects: Record<
  ExternalPlatform,
  { origin: string; query: string; pattern: RegExp; hint: string }
> = {
  'jimeng-canvas': {
    origin: 'https://jimeng.jianying.com',
    query: 'projectId',
    pattern: /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i,
    hint: '全能画布项目 ID 应为 UUID',
  },
  'jimeng-novel': {
    origin: 'https://jimeng.jianying.com',
    query: 'projectId',
    pattern: /^[1-9]\d{0,19}$/,
    hint: '短剧项目 ID 应为数字',
  },
}

/** Project and space IDs are opaque decimal strings; never round-trip them through Number. */
export function parseNovelTarget(target: string): { projectId: string; teamId?: string } {
  const match = /^(?:(0|[1-9]\d{0,19})\/)?([1-9]\d{0,19})$/.exec(target)
  if (!match) throw new Error('请输入短剧数字项目 ID，或空间 ID/项目 ID')
  return { projectId: match[2]!, ...(match[1] !== undefined ? { teamId: match[1] } : {}) }
}

export function canonicalTarget(ref: ExternalTarget): ExternalTarget {
  const spec = projects[ref.provider]
  let id = ref.target.trim()
  if (id.startsWith('https://')) {
    const invalid = () => new Error('请粘贴只含一个项目 ID 的官方画布链接')
    // WHATWG URL resolves dot segments and treats backslashes as path separators.
    // Check the pasted path before normalization so it cannot masquerade as a canvas link.
    const location = /^https:\/\/([^/?#]+)([^?#]*)/.exec(id)
    if (
      !location ||
      location[1]!.includes('@') ||
      location[0].includes('\\') ||
      /[\r\n\t]/.test(id)
    )
      throw invalid()
    const rawPath = location[2]!
    if (/(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)|%(?:2f|5c)/i.test(rawPath)) throw invalid()
    const url = URL.parse(id)
    if (!url || url.origin !== spec.origin || url.username || url.password) throw invalid()
    const ids = url.searchParams.getAll(spec.query)
    const canvasPath = '/ai-tool/ai-canvas/'
    if (url.pathname.startsWith(canvasPath) && url.pathname.length > canvasPath.length) {
      // Only this product uses the UUID path. Never fall back to a query ID for a malformed path.
      if (ref.provider !== 'jimeng-canvas' || ids.length) throw invalid()
      id = url.pathname.slice(canvasPath.length).replace(/\/$/, '')
    } else {
      if (ids.length !== 1) throw invalid()
      id = ids[0]!
    }
    if (!spec.pattern.test(id)) throw new Error(spec.hint)
  }
  if (ref.provider === 'jimeng-novel') {
    parseNovelTarget(id)
    return { provider: ref.provider, target: id }
  }
  if (!spec.pattern.test(id)) throw new Error(spec.hint)
  return { provider: ref.provider, target: id.toLowerCase() }
}

/** An unresolved legacy target may point into any space. Serialize matching project IDs,
 * while keeping the confirmed space in stored bindings and CLI arguments. */
export function projectLockKey(ref: ExternalTarget): string {
  return JSON.stringify([
    ref.provider,
    ref.provider === 'jimeng-novel' ? parseNovelTarget(ref.target).projectId : ref.target,
  ])
}
