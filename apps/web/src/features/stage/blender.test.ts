import { defaultStageScene, recordStageKeyframe } from '@plein/nodes'
import { describe, expect, it } from 'vite-plus/test'
import { blenderStageDocument } from './blender'

describe('Blender 构图交换', () => {
  it('保留人物、场景和关键帧，并将当前预演时刻限制在有效范围', () => {
    const scene = recordStageKeyframe(defaultStageScene(), 0)
    const doc = blenderStageDocument('宿舍', scene, 100)
    expect(doc).toMatchObject({ format: 'plein.stage', version: 1, name: '宿舍', time: 5 })
    expect(doc.scene.figures).toEqual(scene.figures)
    expect(doc.scene.motion?.keyframes).toEqual(scene.motion?.keyframes)
  })

  it('拒绝超出构图范围的对象，不悄悄导出无效场景', () => {
    const scene = defaultStageScene()
    scene.figures[0]!.x = 1000
    expect(() => blenderStageDocument('宿舍', scene, 0)).toThrow()
  })
})
