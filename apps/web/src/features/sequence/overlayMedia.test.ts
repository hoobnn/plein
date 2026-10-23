import { arrangeSequence, sequenceNode, sequenceTimeline } from '@plein/nodes'
import type { PortValue } from '@plein/plugin-sdk'
import { expect, it } from 'vite-plus/test'
import { overlayMediaProblem } from './overlayMedia'

const inputs: PortValue[] = [{ type: 'video', kind: 'video', assetId: 'overlay', source: 'layer' }]
const params = sequenceNode.params.parse({
  overlays: [
    { id: 'one', source: 'layer', clip: 'clip', start: 0.5, in: 0.1, duration: 8, speed: 2 },
  ],
})
const rows = arrangeSequence(params, {
  clips: [{ type: 'video', kind: 'video', assetId: 'base', source: 'clip' }],
})
const timeline = sequenceTimeline(params, rows, { clips: [2], dialogue: [] })
it('窗口按当前锚定镜头截断后再乘overlay速度，和素材时长比较', () => {
  expect(overlayMediaProblem(params, rows, inputs, timeline, () => 3)).toContain('超出源视频结尾')
  expect(overlayMediaProblem(params, rows, inputs, timeline, () => 3.1)).toBeUndefined()
})
it('素材信息未就绪时阻止假装可导出，隐藏图层不要求解码或时长', () => {
  expect(overlayMediaProblem(params, rows, inputs, timeline, () => undefined)).toContain('尚未就绪')
  const hidden = {
    ...params,
    overlays: params.overlays.map((overlay) => ({ ...overlay, hidden: true })),
  }
  expect(overlayMediaProblem(hidden, rows, [], timeline, () => undefined)).toBeUndefined()
})
