import type { CanvasElement } from '@plein/doc'
import { imageProcessNode } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Catalog } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { constrainFields } from './modelParams'
import { fieldsOf, type NodeInfo, type Upstream, validate } from './nodes'

const node: NodeInfo = { ...describeNode(imageProcessNode, 'plein/core'), executable: true }
const catalog = {
  providers: [
    {
      id: 'p',
      enabled: true,
      configured: true,
      models: [
        {
          id: 'm',
          title: 'M',
          capabilities: ['image.process'],
          limits: { imageOperations: ['upscale', 'outpaint', 'cutout'] },
        },
      ],
    },
  ],
} as unknown as Catalog

describe('图片精修前端合同', () => {
  it('按操作仅显示实际生效的尺寸字段，操作选项受模型能力约束', () => {
    const fields = (operation: string) =>
      Object.fromEntries(
        constrainFields(node, fieldsOf(node), { imageOperations: ['cutout'] }, { operation }),
      )
    expect(fields('upscale')).toHaveProperty('scale')
    expect(fields('upscale')).not.toHaveProperty('left')
    expect(fields('outpaint')).not.toHaveProperty('scale')
    expect(fields('outpaint')).toHaveProperty('left')
    expect(fields('cutout')).not.toHaveProperty('scale')
    expect(fields('cutout')).not.toHaveProperty('top')
    expect(fields('cutout').operation?.enum).toEqual(['cutout'])
  })

  it('已连原图可用默认精修要求，缺原图仍在提交前说明', () => {
    const el = {
      id: 'target',
      kind: 'node',
      params: { ...node.defaults, model: 'p:m', prompt: '' },
    } as unknown as CanvasElement
    const source = { id: 'source', kind: 'image', assetId: 'a'.repeat(64) } as CanvasElement
    const ups = new Map<string, Upstream[]>([
      ['image', [{ edgeId: 'edge', source, value: { type: 'image', assetId: source.assetId! } }]],
    ])
    expect(validate(node, el, ups, catalog)).toBeNull()
    expect(validate(node, el, new Map(), catalog)).toBe('需要连入原图')
  })
})
