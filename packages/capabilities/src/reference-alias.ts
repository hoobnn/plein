import { elementPorts, type PleinDoc } from '@plein/doc'

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

/**
 * 名称绑定用的显示别名：来源名 + 同名 #序号（按元素 id 排，与 @ 菜单一致），
 * 非默认输出口再加「·端口名」。正文与绑定键都用这一个结果。
 */
export function referenceAlias(
  doc: PleinDoc,
  identity: { source?: string; sourcePort?: string },
): string | undefined {
  const source = identity.source
  if (!source || !doc.has(source)) return undefined
  const element = doc.get(source)!
  const name = element.name?.trim() || '参考素材'
  const peers = [...doc.elements()]
    .filter((el) => (el.name?.trim() || '参考素材') === name)
    .sort(byId)
  const index = peers.findIndex((el) => el.id === source)
  const base = peers.length > 1 ? `${name}#${index + 1}` : name
  const port = referencePortLabel(doc, source, identity.sourcePort)
  return port ? `${base}·${port}` : base
}
