import { describe, expect, it } from 'vite-plus/test'
import {
  StageMotion,
  StageScene,
  defaultStageScene,
  recordStageKeyframe,
  sampleStageScene,
  stageSceneOf,
} from './stage'

function movement() {
  const base = defaultStageScene()
  base.figures[0]!.facing = 350
  const start = recordStageKeyframe(base, 0)
  return recordStageKeyframe(start, 5, {
    ...start,
    figures: [{ ...start.figures[0]!, x: 10, z: -4, facing: 10, pose: 'sit' }],
    camera: { ...start.camera, x: 4, focal: 85 },
  })
}

describe('动态3D关键帧', () => {
  it('静态场景无需迁移，播放采样不修改场景、版本或既有关键帧', () => {
    const base = defaultStageScene()
    expect(sampleStageScene(base, 10)).toBe(base)
    const scene = movement()
    const before = structuredClone(scene)
    sampleStageScene(scene, 1)
    sampleStageScene(scene, 4.9)
    expect(scene).toEqual(before)
  })
  it('按对象ID插值人物和镜头，朝向取最短转角，姿态在关键帧处切换', () => {
    const scene = movement()
    const half = sampleStageScene(scene, 2.5)
    expect(half.figures[0]).toMatchObject({ x: 5, z: -2, facing: 0, pose: 'stand' })
    expect(half.camera).toMatchObject({ x: 2, focal: 60 })
    expect(sampleStageScene(scene, 5).figures[0]).toMatchObject({ x: 10, pose: 'sit' })
    expect(sampleStageScene(scene, -20).figures[0]!.x).toBe(0)
    expect(sampleStageScene(scene, 200).figures[0]!.x).toBe(10)
    expect(sampleStageScene(scene, NaN).figures[0]!.x).toBe(0)
  })
  it('在插值时刻编辑仅新增或替换这一帧，保留其他帧、基础外观和静态场景件', () => {
    const scene = movement()
    const pose = sampleStageScene(scene, 2.5)
    pose.figures = [{ ...pose.figures[0]!, x: 7 }]
    const changed = recordStageKeyframe(scene, 2.5, pose)
    expect(changed.motion!.keyframes.map((frame) => frame.time)).toEqual([0, 2.5, 5])
    expect(changed.motion!.keyframes[0]).toEqual(scene.motion!.keyframes[0])
    expect(changed.motion!.keyframes[2]).toEqual(scene.motion!.keyframes[1])
    expect(changed.figures).toEqual(scene.figures)
    expect(sampleStageScene(changed, 2.5).figures[0]!.x).toBe(7)
    const replaced = recordStageKeyframe(changed, 2.5)
    expect(replaced.motion!.keyframes).toHaveLength(3)
    const imported = structuredClone(scene)
    imported.motion!.keyframes[0]!.id = 'key-2500'
    const inserted = recordStageKeyframe(imported, 2.5)
    expect(new Set(inserted.motion!.keyframes.map((frame) => frame.id)).size).toBe(3)
    const removed = { ...changed, figures: [] }
    expect(sampleStageScene(removed, 2.5).figures).toEqual([])
  })
  it('轨迹损坏时保留静态构图，不接受无限值、重复时间或超出时长', () => {
    const scene = movement()
    const frame = scene.motion!.keyframes[0]!
    expect(StageMotion.safeParse({ duration: Infinity, keyframes: [frame] }).success).toBe(false)
    expect(
      StageMotion.safeParse({ duration: 5, keyframes: [frame, { ...frame, id: 'duplicate' }] })
        .success,
    ).toBe(false)
    expect(StageMotion.safeParse({ duration: 1, keyframes: scene.motion!.keyframes }).success).toBe(
      false,
    )
    expect(
      StageScene.safeParse({
        ...scene,
        motion: { ...scene.motion, keyframes: [{ ...frame, camera: { ...frame.camera, x: NaN } }] },
      }).success,
    ).toBe(false)
    const recovered = stageSceneOf({ scene: { ...scene, motion: 'broken' } })
    expect(recovered.figures).toEqual(scene.figures)
    expect(recovered.motion).toBeUndefined()
  })
  it('关键帧满额后拒绝新时刻，但仍能更新已有时刻', () => {
    let scene = recordStageKeyframe(defaultStageScene(), 0)
    scene.motion!.duration = 60
    for (let n = 1; n < 60; n++) scene = recordStageKeyframe(scene, n)
    expect(() => recordStageKeyframe(scene, 60)).toThrow('60')
    expect(recordStageKeyframe(scene, 30).motion!.keyframes).toHaveLength(60)
  })
})
