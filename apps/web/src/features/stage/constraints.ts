import { STAGE_BOUNDS, type StageCamera } from '@plein/nodes'

const bounded = (v: number, range: { min: number; max: number }, fallback = 0) =>
  Math.round(Math.max(range.min, Math.min(range.max, Number.isNaN(v) ? fallback : v)) * 100) / 100

export const stageGround = (v: number) => bounded(v, STAGE_BOUNDS.ground)

/** 控制器的自由轨道不能把持久化场景带到 schema 范围之外。 */
export function stageCameraBounds(camera: StageCamera): StageCamera {
  const result = {
    ...camera,
    x: stageGround(camera.x),
    y: bounded(camera.y, STAGE_BOUNDS.cameraHeight, 1.5),
    z: stageGround(camera.z),
    tx: stageGround(camera.tx),
    ty: bounded(camera.ty, STAGE_BOUNDS.targetHeight, 1.2),
    tz: stageGround(camera.tz),
  }
  // 两端都被夹到同一边界时，仍给机位与目标保留可观察的距离。
  if (Math.hypot(result.x - result.tx, result.y - result.ty, result.z - result.tz) < 0.25) {
    result.z = result.tz > STAGE_BOUNDS.ground.max - 0.25 ? result.tz - 0.25 : result.tz + 0.25
  }
  return result
}
