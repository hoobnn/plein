import { defaultStageScene, StageScene } from '@plein/nodes'
import { describe, expect, it } from 'vite-plus/test'
import { stageCameraBounds, stageGround } from './constraints'

describe('3D 交互坐标边界', () => {
  it.each([
    [-Infinity, -50],
    [-500, -50],
    [500, 50],
    [Infinity, 50],
    [NaN, 0],
    [1.234, 1.23],
  ])('地面坐标 %s 写回为 %s', (value, expected) => {
    expect(stageGround(value)).toBe(expected)
  })

  it.each([Infinity, -Infinity, NaN, 100000, -100000])('异常机位 %s 不使人物和场景回退', (v) => {
    const scene = defaultStageScene()
    scene.figures[0]!.pose = 'sit'
    scene.camera = stageCameraBounds({ x: v, y: v, z: v, tx: v, ty: v, tz: v, focal: 85 })
    const parsed = StageScene.safeParse(scene)
    expect(parsed.success).toBe(true)
    expect(parsed.data!.figures[0]!.pose).toBe('sit')
    expect(parsed.data!.camera.focal).toBe(85)
    const c = parsed.data!.camera
    expect(Math.hypot(c.x - c.tx, c.y - c.ty, c.z - c.tz)).toBeGreaterThanOrEqual(0.25)
  })

  it('正常机位按厘米确认，方向和目标保留', () => {
    const camera = { x: 2.1234, y: 5.5678, z: -3.1415, tx: 1, ty: -2, tz: 3, focal: 50 }
    expect(stageCameraBounds(camera)).toEqual({ ...camera, x: 2.12, y: 5.57, z: -3.14 })
  })
})
