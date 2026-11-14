import { type CanvasElement, elementPorts, type PleinDoc } from '@plein/doc'

/** 已知输出口的中文名；未知端口直接写端口 id，不编造显示名。 */
const PORT_LABELS: Record<string, string> = {
  lastFrame: '尾帧',
  firstFrame: '首帧',
  video: '视频',
  image: '图片',
  audio: '音频',
  text: '文本',
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

const identityKey = (source: string, sourcePort?: string) => `${source}\u0000${sourcePort ?? ''}`

/** 来源元素的默认输出口：素材就是它自己的种类，节点取声明的第一个输出口。 */
export function defaultOutputPort(doc: PleinDoc, source: string) {
  const el = doc.get(source)
  if (!el) return undefined
  if (el.kind !== 'node') return el.kind
  return elementPorts(el)?.outputs[0]?.id
}

/** 非默认输出口才加后缀；同一节点的视频和尾帧需要可读且互不冲突的别名。 */
export function referencePortLabel(doc: PleinDoc, source: string, sourcePort?: string) {
  if (!sourcePort || defaultOutputPort(doc, source) === sourcePort) return undefined
  const el = doc.get(source)
  if (!el) return PORT_LABELS[sourcePort] ?? sourcePort
  const label = elementPorts(el)?.outputs.find((port) => port.id === sourcePort)?.label
  return label ?? PORT_LABELS[sourcePort] ?? sourcePort
}

interface AliasCandidate {
  alias: string
  source: string
  sourcePort?: string
}

/**
 * 全画布的引用别名表（来源 + 输出口 → 别名）。
 *
 * 元素本身用「名称 + 同名 #序号」；非默认输出口再加「·端口名」。
 * 两类别名可能撞车（例如节点「镜头」的尾帧、恰好还有一张名为「镜头·尾帧」的素材），
 * 撞车时按身份键稳定地补 #2/#3，保证两处引用可以同时存在、不会绑错。
 */
export function referenceAliasMap(doc: PleinDoc) {
  const groups = new Map<string, Array<{ id: string; element: CanvasElement }>>()
  for (const el of doc.elements()) {
    const name = el.name?.trim() || '参考素材'
    const list = groups.get(name) ?? []
    list.push({ id: el.id, element: el })
    groups.set(name, list)
  }
  const candidates = new Map<string, AliasCandidate>()
  for (const [name, entries] of groups) {
    entries.sort(byId)
    for (const [index, entry] of entries.entries()) {
      const base = entries.length > 1 ? `${name}#${index + 1}` : name
      const element = entry.element!
      candidates.set(identityKey(entry.id), { alias: base, source: entry.id })
      const outputs = elementPorts(element)?.outputs ?? []
      const fallback = element.kind === 'node' ? outputs[0]?.id : element.kind
      for (const port of outputs) {
        if (port.id === fallback) continue
        const label = port.label ?? PORT_LABELS[port.id] ?? port.id
        candidates.set(identityKey(entry.id, port.id), {
          alias: `${base}·${label}`,
          source: entry.id,
          sourcePort: port.id,
        })
      }
    }
  }
  // 元素本体别名优先保留，端口别名撞车时按身份键顺序补序号。
  const used = new Set<string>()
  for (const candidate of candidates.values()) if (!candidate.sourcePort) used.add(candidate.alias)
  const ports = [...candidates.entries()]
    .filter(([, candidate]) => candidate.sourcePort)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  for (const [, candidate] of ports) {
    let alias = candidate.alias
    for (let index = 2; used.has(alias); index++) alias = `${candidate.alias}#${index}`
    candidate.alias = alias
    used.add(alias)
  }
  return new Map([...candidates].map(([key, candidate]) => [key, candidate.alias]))
}

/**
 * 名称绑定用的显示别名：来源名 + 同名 #序号（按元素 id 排，与 @ 菜单一致），
 * 非默认输出口再加「·端口名」；与全画布其他别名撞车时补序号。正文与绑定键都用这一个结果。
 */
export function referenceAlias(
  doc: PleinDoc,
  identity: { source?: string; sourcePort?: string },
): string | undefined {
  const source = identity.source
  if (!source || !doc.has(source)) return undefined
  const aliases = referenceAliasMap(doc)
  const base = aliases.get(identityKey(source))
  // 默认输出口沿用元素自己的别名，不额外加后缀。
  if (!identity.sourcePort || defaultOutputPort(doc, source) === identity.sourcePort) return base
  const exact = aliases.get(identityKey(source, identity.sourcePort))
  if (exact) return exact
  if (!base) return base
  const label = PORT_LABELS[identity.sourcePort] ?? identity.sourcePort
  return `${base}·${label}`
}
