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

const scrollRegion = (label: string) =>
  `<div class="plein-md-scroll ui-scrollbar" data-plein-scroll tabindex="0" role="region" aria-label="${label}" title="横向滚动或 Shift + 滚轮查看完整内容">\n`

for (const rule of ['fence', 'code_block'] as const) {
  const render = md.renderer.rules[rule]!
  md.renderer.rules[rule] = (tokens, idx, options, env, self) =>
    `${scrollRegion('代码块')}${render(tokens, idx, options, env, self)}</div>\n`
}
const tableOpen = md.renderer.rules.table_open
const tableClose = md.renderer.rules.table_close
md.renderer.rules.table_open = (tokens, idx, options, env, self) =>
  `${scrollRegion('表格')}${tableOpen ? tableOpen(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options)}`
md.renderer.rules.table_close = (tokens, idx, options, env, self) =>
  `${tableClose ? tableClose(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options)}</div>\n`

export function renderMarkdown(text: string) {
  return md.render(text)
}
