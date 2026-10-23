import { parseHTML } from 'linkedom'
import { MotionError } from './process'

const resourceAttributes = new Set([
  'src',
  'href',
  'action',
  'formaction',
  'poster',
  'data',
  'xlink:href',
  'background',
  'manifest',
  'codebase',
  'archive',
  'ping',
])
const unescapeCode = (value: string) =>
  value
    .replace(
      /\\u\{([\da-f]+)\}|\\u([\da-f]{4})|\\x([\da-f]{2})/gi,
      (_match, a: string, b: string, c: string) =>
        String.fromCodePoint(Number.parseInt(a ?? b ?? c, 16)),
    )
    .replace(/\\([\da-f]{1,6})(?:\s)?/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\([^\da-f\r\n])/gi, '$1')

function fail(context: string): never {
  throw new MotionError(
    'motion_external_resource',
    `Motion ${context} must use packaged relative resources only`,
  )
}

function localResource(value: string, context: string) {
  const path = value.trim()
  if (!path || /^#[A-Za-z0-9_-]+$/.test(path)) return
  if (
    !/^[A-Za-z0-9_-][A-Za-z0-9_./-]{0,499}$/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    fail(context)
}

/** CSS is inspected only in executable CSS contexts; normal text is not CSS. */
function inspectCss(value: string) {
  const css = unescapeCode(value).replace(/\/\*[\s\S]*?\*\//g, '')
  if (/@import\b|expression\s*\(|-moz-binding\s*:|behavior\s*:/i.test(css)) fail('CSS')
  for (const match of css.matchAll(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi))
    localResource(match[2]!, 'CSS URL')
  // Refuse malformed url() rather than treating an incomplete parse as safe.
  const tokens = css.match(/url\s*\(/gi)?.length ?? 0
  if (tokens !== [...css.matchAll(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi)].length) fail('CSS URL')
}

/** Closed generated templates only; this is an offline contract check, not an arbitrary JS sandbox. */
export function assertLocalMotionHtml(html: string): void {
  const { document } = parseHTML(html) as unknown as {
    document: {
      querySelectorAll(selector: string): Iterable<{
        tagName: string
        attributes: Iterable<{ name: string; value: string }>
        hasAttribute(name: string): boolean
        textContent: string | null
      }>
    }
  }
  for (const element of document.querySelectorAll('*')) {
    const tag = element.tagName.toLowerCase()
    if (['base', 'iframe', 'object', 'embed', 'meta'].includes(tag)) {
      if (tag !== 'meta' || element.hasAttribute('http-equiv')) fail(tag)
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || name === 'srcdoc') fail(name)
      if (resourceAttributes.has(name)) localResource(attribute.value, name)
      if (name === 'srcset') {
        for (const candidate of attribute.value.split(','))
          localResource(candidate.trim().split(/\s+/)[0] ?? '', name)
      }
      if (name === 'style') inspectCss(attribute.value)
    }
    if (tag === 'style') inspectCss(element.textContent ?? '')
    if (tag === 'script') {
      const script = unescapeCode(element.textContent ?? '')
      if (
        /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|eval|Function|createElement|location|navigator)\b|\bimport\s*\(|@import\b|\burl\s*\(|(?:https?|wss?|ftp|file|data|javascript|blob):|localhost|127\.0\.0\.1|\[::1\]/i.test(
          script,
        )
      )
        fail('script')
    }
  }
}
