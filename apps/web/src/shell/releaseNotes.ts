import { renderMarkdown } from '../canvas/markdown'

const allowedTags = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'code',
  'pre',
  'blockquote',
  'br',
  'hr',
  'a',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'del',
])

const discardedTags = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'template',
  'svg',
  'math',
  'head',
  'title',
  'noscript',
  'audio',
  'video',
])

// GitHub's Atom feed supplies HTML, while other providers supply Markdown.
// Only a leading HTML tag (optionally after comments) selects the HTML parser;
// inline tags and fenced code in Markdown stay literal through renderMarkdown.
const startsWithHtml = /^\s*(?:<!--[\s\S]*?-->\s*)*<\/?[a-z][\w:-]*(?:\s[^<>]*|\/?)>/i

function safeLink(href: string | null) {
  if (!href) return null
  try {
    const url = new URL(href)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

/** Render release metadata without mounting or returning untrusted HTML. */
export function renderReleaseNotes(note: string): string {
  if (!startsWithHtml.test(note) || typeof document === 'undefined') {
    return renderMarkdown(note)
  }

  // A template's contents are inert: resources and scripts in the source never
  // become part of the active document. Rebuild everything in a separate tree.
  const source = document.createElement('template')
  source.innerHTML = note
  const output = document.createElement('div')

  const append = (parent: Node, node: Node) => {
    if (node.nodeType === 3) {
      parent.appendChild(document.createTextNode(node.textContent ?? ''))
      return
    }
    if (node.nodeType !== 1) return

    const element = node as Element
    const tag = element.localName.toLowerCase()
    if (discardedTags.has(tag)) return

    const href = tag === 'a' ? safeLink(element.getAttribute('href')) : null
    let target = parent
    if (allowedTags.has(tag) && (tag !== 'a' || href)) {
      const clean = document.createElement(tag)
      if (href) {
        clean.setAttribute('href', href)
        clean.setAttribute('target', '_blank')
        clean.setAttribute('rel', 'noopener noreferrer')
      }
      if (tag === 'pre' || tag === 'table') {
        const scroll = document.createElement('div')
        scroll.className = 'plein-md-scroll ui-scrollbar'
        scroll.setAttribute('data-plein-scroll', '')
        scroll.setAttribute('tabindex', '0')
        scroll.setAttribute('role', 'region')
        scroll.setAttribute('aria-label', tag === 'pre' ? '代码块' : '表格')
        scroll.setAttribute('title', '横向滚动或 Shift + 滚轮查看完整内容')
        scroll.appendChild(clean)
        parent.appendChild(scroll)
      } else parent.appendChild(clean)
      target = clean
    }
    for (const child of element.childNodes) append(target, child)
  }

  for (const node of source.content.childNodes) append(output, node)
  return output.innerHTML
}
