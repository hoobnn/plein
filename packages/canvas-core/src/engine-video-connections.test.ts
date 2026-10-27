import { connect, createElement } from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { afterEach, expect, it } from 'vite-plus/test'
import { initEngine, pointerEvent } from './testing'

const cleanups: (() => void)[] = []
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup()),
)

it.each([false, true])('视频共用连接点反向=%s，总是优先主视频并保留原下游', async (reverse) => {
  const doc = openDoc()
  const video = (x: number, y = 0) =>
    createElement(
      doc,
      node({
        x,
        y,
        w: 300,
        h: 200,
        nodeType: 'plein/video',
        ports: {
          inputs: [
            { id: 'images', label: '图片', type: 'image', multiple: true },
            { id: 'videos', label: '视频', type: 'video', multiple: true },
          ],
          outputs: [
            { id: 'video', label: '视频', type: 'video' },
            { id: 'lastFrame', label: '尾帧', type: 'image' },
          ],
        },
      }),
    )
  const source = video(100),
    target = video(700)
  const other = reverse ? video(700, 500) : null
  if (other) connect(doc, [source, 'video'], [other, 'videos'])
  doc.flush()
  const { engine, host, cleanup } = await initEngine(doc)
  cleanups.push(() => doc.destroy(), cleanup)
  const point = (id: string, side: 'in' | 'out') => {
    const rect = doc.worldRect(id)!
    return engine.camera.worldToScreen(rect.x + (side === 'out' ? rect.w : 0), rect.y + rect.h / 2)
  }
  const out = point(source, 'out'),
    input = point(target, 'in')
  const [from, to] = reverse ? [input, out] : [out, input]
  for (const [type, at] of [
    ['pointermove', from],
    ['pointerdown', from],
    ['pointermove', to],
    ['pointerup', to],
  ] as const)
    host.dispatchEvent(pointerEvent(type, { clientX: at.x, clientY: at.y }))
  expect(
    [...doc.edges()].filter((edge) => edge.to[0] === target).map((edge) => [edge.from, edge.to]),
  ).toEqual([
    [
      [source, 'video'],
      [target, 'videos'],
    ],
  ])
  if (other)
    expect([...doc.edges()].some((edge) => edge.to[0] === other && edge.from[1] === 'video')).toBe(
      true,
    )
})
