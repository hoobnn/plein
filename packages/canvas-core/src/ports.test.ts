import type { CanvasElement, Port } from '@plein/doc'
import { describe, expect, it } from 'vite-plus/test'
import { canConnect, hitPort, type PortRef } from './ports'

const port = (id: string, type: Port['type'] = 'text'): Port => ({ id, label: id, type })

const el = (id: string, x = 0): [CanvasElement, { x: number; y: number; w: number; h: number }] => {
  const rect = { x, y: 0, w: 100, h: 100 }
  return [
    {
      id,
      kind: 'node',
      ...rect,
      rotation: 0,
      z: 'a',
      parentId: null,
      locked: false,
      ports: { inputs: [port('in')], outputs: [port('out')] },
    },
    rect,
  ]
}

const ref = (elementId: string, side: PortRef['side'], type: Port['type'] = 'text'): PortRef => ({
  elementId,
  side,
  port: port(side, type),
  x: 0,
  y: 0,
})

describe('端口', () => {
  it.each([
    ['输出接输入', ref('a', 'out'), ref('b', 'in'), true],
    ['同一元素', ref('a', 'out'), ref('a', 'in'), false],
    ['同一侧', ref('a', 'out'), ref('b', 'out'), false],
    ['类型不符', ref('a', 'out'), ref('b', 'in', 'image'), false],
    ['any 通配', ref('a', 'out', 'any'), ref('b', 'in', 'image'), true],
  ])('canConnect：%s', (_, a, b, ok) => {
    expect(canConnect(a, b)).toBe(ok)
  })

  it('hitPort 取半径内最近的端口，可过滤', () => {
    // a 的输出在 (100, 50)，b 的输入在 (104, 50)
    const candidates = [el('a'), el('b', 104)]
    expect(hitPort(candidates, 101, 50, 6)).toMatchObject({ elementId: 'a', side: 'out' })
    expect(hitPort(candidates, 103, 50, 6)).toMatchObject({ elementId: 'b', side: 'in' })
    expect(hitPort(candidates, 101, 50, 6, (r) => r.side === 'in')).toMatchObject({
      elementId: 'b',
    })
    expect(hitPort(candidates, 100, 60, 6)).toBeNull()
  })
})
