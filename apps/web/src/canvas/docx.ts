import { strFromU8, unzipSync } from 'fflate'

const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const MAX_FILE = 10 * 1024 * 1024
const MAX_XML = 8 * 1024 * 1024
const MAX_TEXT = 200_000
const INVALID = '无法读取 DOCX，请确认文件未损坏、未加密；旧版 .doc 请另存为 .docx 或 .txt'

function xml(source: string) {
  // 不接受自定义实体；不加载文档关系或任何外部内容。
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error(INVALID)
  const doc = new DOMParser().parseFromString(source, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error(INVALID)
  return doc
}

function children(el: Element, name?: string) {
  return [...el.children].filter(
    (child) => child.namespaceURI === WORD && (!name || child.localName === name),
  )
}

/**
 * 命名空间里的第一个后代元素。
 * 不依赖 getElementsByTagNameNS：部分 DOM 实现按限定名匹配该方法，
 * 这里统一按 namespaceURI + localName 遍历，浏览器与测试环境结果一致。
 */
function first(el: Element | Document, name: string) {
  for (const node of el.getElementsByTagName('*')) {
    if (node.namespaceURI === WORD && node.localName === name) return node
  }
  return undefined
}

/**
 * 命名空间里的属性值；同样不依赖 getAttributeNS，部分实现不返回属性的命名空间。
 * 有命名空间时按命名空间判断，只有拿不到命名空间时才退回限定名。
 */
function attr(el: Element | undefined, name: string) {
  if (!el) return undefined
  for (const node of el.attributes) {
    if (node.namespaceURI) {
      if (node.namespaceURI === WORD && node.localName === name) return node.value
    } else if (node.name === `w:${name}`) return node.value
  }
  return undefined
}

function escape(text: string) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll(/([\\`*_[\]{}()#+.!|~>-])/g, '\\$1')
}

function inline(el: Element, depth = 0): string {
  if (depth > 100) throw new Error('DOCX 正文结构过深，请另存为文本后导入')
  if (el.namespaceURI !== WORD) return ''
  switch (el.localName) {
    case 't':
      return escape(el.textContent ?? '')
    case 'tab':
      return '    '
    case 'br':
    case 'cr':
      return '\n'
    // 修订删除的文字和域代码不是当前正文。
    case 'del':
    case 'instrText':
    case 'drawing':
    case 'pict':
      return ''
    default:
      return children(el)
        .map((child) => inline(child, depth + 1))
        .join('')
  }
}

function paragraph(el: Element) {
  const text = inline(el).trim()
  if (!text) return ''
  const properties = children(el, 'pPr')[0]
  const level = properties && attr(first(properties, 'ilvl'), 'val')
  const num = properties && first(properties, 'numPr')
  // 保留列表层次；Word 自定义编号统一成 Markdown 项目符号。
  if (num) return `${'  '.repeat(Math.max(0, Math.min(8, Number(level) || 0)))}- ${text}`
  const style = properties && attr(first(properties, 'pStyle'), 'val')
  const heading = style?.match(/^(?:Heading|标题)\s*([1-6])$/i)
  return heading ? `${'#'.repeat(Number(heading[1]))} ${text}` : text
}

function table(el: Element, depth: number) {
  const sourceRows = children(el, 'tr')
  const width = sourceRows.reduce((max, row) => Math.max(max, children(row, 'tc').length), 0)
  if (sourceRows.length > 2000 || width > 100 || sourceRows.length * width > 10_000)
    throw new Error('DOCX 表格过大，请拆分表格或另存为文本后导入')
  const rows = sourceRows.map((row) =>
    children(row, 'tc').map((cell) =>
      blocks(cell, depth + 1)
        .join(' / ')
        .replaceAll('\n', ' / '),
    ),
  )
  if (!width) return ''
  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`
  // 首行按 Markdown 表头表示；合并单元格不复原版式。
  return [
    line(rows[0]!),
    line(Array.from({ length: width }, () => '---')),
    ...rows.slice(1).map(line),
  ].join('\n')
}

function blocks(el: Element, depth = 0): string[] {
  if (depth > 30) throw new Error('DOCX 正文结构过深，请另存为文本后导入')
  return children(el)
    .flatMap((child): string[] => {
      if (child.localName === 'p') return [paragraph(child)]
      if (child.localName === 'tbl') return [table(child, depth)]
      if (child.localName === 'sdt' || child.localName === 'sdtContent')
        return blocks(child, depth + 1)
      return []
    })
    .filter(Boolean)
}

/** 只提取 DOCX 正文为可编辑参考；原件和其中的媒体不会上传或保存。 */
export async function readDocx(file: File): Promise<string> {
  if (file.size > MAX_FILE) throw new Error('DOCX 超过 10 MiB，请拆分文档或另存为文本后导入')
  let body: Element | undefined
  let xmlSize = 0
  try {
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
      filter(entry) {
        if (entry.name !== 'word/document.xml') return false
        xmlSize += entry.originalSize
        if (xmlSize > MAX_XML) throw new Error('DOCX 正文解压后超过 8 MiB，请拆分后导入')
        return true
      },
    })
    const data = entries['word/document.xml']
    if (!data) throw new Error(INVALID)
    body = first(xml(strFromU8(data)), 'body')
  } catch (error) {
    if (error instanceof Error && error.message.includes('超过')) throw error
    throw new Error(INVALID)
  }
  if (!body) throw new Error(INVALID)
  const text = blocks(body).join('\n\n')
  if (!text.trim()) throw new Error('DOCX 中没有可读取的正文文本；扫描件或图片文字请先转为文本')
  if (text.length > MAX_TEXT)
    throw new Error('DOCX 正文超过 200,000 字符，未导入或截断；请拆分文档后导入')
  const name = escape(file.name.replaceAll(/[\r\n]/g, ' '))
  return `> 来源：${name}\n> DOCX 正文文本转换；列表编号与表格版式已简化，不含图片、批注及页眉页脚。请保留原件。\n\n${text}`
}
