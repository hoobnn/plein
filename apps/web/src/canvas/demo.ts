import { connect, createElements, type NewElement, type PleinDoc, type Ports } from '@plein/doc'

const NODE_PORTS: Ports = {
  inputs: [
    { id: 'prompt', label: '提示词', type: 'text' },
    { id: 'ref', label: '参考图', type: 'image' },
  ],
  outputs: [{ id: 'out', label: '输出', type: 'image' }],
}

const PALETTES = [
  ['#2b5876', '#4e4376'],
  ['#ff9a9e', '#fad0c4'],
  ['#a1c4fd', '#c2e9fb'],
  ['#f6d365', '#fda085'],
  ['#84fab0', '#8fd3f4'],
  ['#cfd9df', '#e2ebf0'],
]

/** 演示用的渐变图片，assetId 形如 demo:0 */
export function demoAssetUrls(): Map<string, string> {
  const urls = new Map<string, string>()
  PALETTES.forEach(([a, b], i) => {
    const c = document.createElement('canvas')
    c.width = 480
    c.height = 360
    const g = c.getContext('2d')!
    const grad = g.createLinearGradient(0, 0, 480, 360)
    grad.addColorStop(0, a!)
    grad.addColorStop(1, b!)
    g.fillStyle = grad
    g.fillRect(0, 0, 480, 360)
    urls.set(`demo:${i}`, c.toDataURL('image/png'))
  })
  return urls
}

const W = 240
const H = 180
const GAP = 40

/**
 * 生成演示画布：若干 Frame（各含一组卡片）+ 大片散落元素，节点之间按行连线。
 * 默认 1000 个元素，可用 ?n= 调整。
 */
export function seedDemo(doc: PleinDoc, total = 1000) {
  const frames = Math.min(8, Math.floor(total / 13))
  const perFrame = 12
  const frameW = 3 * (W + GAP) + GAP
  const frameH = 4 * (H + GAP) + GAP + 20

  doc.ydoc.transact(() => {
    let made = 0
    const frameIds = createElements(
      doc,
      Array.from({ length: frames }, (_, i) => ({
        kind: 'frame' as const,
        name: `第 ${i + 1} 场`,
        x: (i % 4) * (frameW + 80),
        y: Math.floor(i / 4) * (frameH + 80),
        w: frameW,
        h: frameH,
      })),
    )
    made += frames
    for (const frameId of frameIds) {
      createElements(
        doc,
        Array.from({ length: perFrame }, (_, i) => ({
          kind: 'image' as const,
          parentId: frameId,
          assetId: `demo:${i % PALETTES.length}`,
          x: GAP + (i % 3) * (W + GAP),
          y: GAP + 20 + Math.floor(i / 3) * (H + GAP),
          w: W,
          h: H,
        })),
      )
      made += perFrame
    }

    const loose = Math.max(0, total - made)
    const cols = Math.ceil(Math.sqrt(loose * 1.6))
    const ox = 4 * (frameW + 80) + 200
    const inputs: NewElement[] = []
    for (let i = 0; i < loose; i++) {
      const x = ox + (i % cols) * (W + GAP * 2)
      const y = Math.floor(i / cols) * (H + GAP)
      const k = i % 4
      if (k === 0)
        inputs.push({ kind: 'node', nodeType: '文生图', ports: NODE_PORTS, x, y, w: W, h: H })
      else if (k === 1)
        inputs.push({ kind: 'image', assetId: `demo:${i % PALETTES.length}`, x, y, w: W, h: H })
      else if (k === 2)
        inputs.push({ kind: 'markdown', text: `# 镜头 ${i}\n画面描述`, x, y, w: W, h: H })
      else inputs.push({ kind: ['video', 'audio'][i % 2] as 'video' | 'audio', x, y, w: W, h: H })
    }
    const ids = createElements(doc, inputs)
    // 同一行相邻的节点：上一个的输出连到下一个的参考图
    for (let i = 4; i < ids.length; i += 4) {
      if (Math.floor(i / cols) === Math.floor((i - 4) / cols))
        connect(doc, [ids[i - 4]!, 'out'], [ids[i]!, 'ref'])
    }
  })
  doc.undo.clear()
}
