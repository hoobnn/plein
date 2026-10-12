import { type CanvasElement, elementPorts } from '@plein/doc'
import type { Catalog } from '@plein/protocol'
import type { IconName } from '../ui/icons'
import { findNode } from './nodes'

/** 侧栏图层与故事板共用的元素分类：按元素产出的内容类型 */
export type OutlineType = 'frame' | 'text' | 'image' | 'video' | 'audio' | 'other'

export const OUTLINE_TYPES: Array<{ type: OutlineType; label: string; icon: IconName }> = [
  { type: 'frame', label: '分组', icon: 'folder' },
  { type: 'text', label: '文本', icon: 'doc' },
  { type: 'image', label: '图片', icon: 'image' },
  { type: 'video', label: '视频', icon: 'video' },
  { type: 'audio', label: '音频', icon: 'audio' },
  { type: 'other', label: '其他', icon: 'json' },
]

export const outlineIcon = (type: OutlineType) => OUTLINE_TYPES.find((t) => t.type === type)!.icon

export function outlineType(el: CanvasElement): OutlineType {
  switch (el.kind) {
    case 'frame':
      return 'frame'
    case 'markdown':
      return 'text'
    case 'image':
    case 'video':
    case 'audio':
      return el.kind
    case 'sequence':
      return 'video'
    case 'node': {
      // 节点按第一个输出端口归类
      const out = elementPorts(el)?.outputs[0]?.type
      return out === 'text' || out === 'image' || out === 'video' || out === 'audio' ? out : 'other'
    }
  }
}

const KIND_LABELS: Record<CanvasElement['kind'], string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  markdown: '文本',
  node: '节点',
  frame: '分组',
  sequence: '序列',
}

/** 列表里显示的名称：自定义名 → 节点类型名 → Markdown 首行 → 元素类型 */
export function outlineTitle(el: CanvasElement, catalog: Catalog | null) {
  if (el.name) return el.name
  if (el.kind === 'node') return findNode(catalog, el.nodeType)?.title ?? el.nodeType ?? '节点'
  if (el.kind === 'markdown' && el.text) {
    const first = el.text
      .trim()
      .split('\n')[0]!
      .replace(/^#+\s*/, '')
    if (first) return first.slice(0, 40)
  }
  return KIND_LABELS[el.kind]
}
