import MarkdownIt from 'markdown-it'

/**
 * Markdown 渲染：关闭原始 HTML（内容来自文件和协作者，不可信），
 * markdown-it 默认会拦截 javascript: 等危险链接。
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

const defaultLink = md.renderer.rules.link_open
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet('target', '_blank')
  tokens[idx]!.attrSet('rel', 'noopener noreferrer')
  return defaultLink
    ? defaultLink(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options)
}

export function renderMarkdown(text: string) {
  return md.render(text)
}
