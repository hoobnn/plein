import { motionDurationFrames, type MotionParams } from '@plein/nodes'
import { MotionError } from './process'

/** Same 30fps quantization as motionHtml(): a media slot need not fill the composition. */
export function motionMediaWindow(params: MotionParams) {
  const startFrame = Math.round(Number(params.overrides['hf-media.timing.start'] ?? 0) * 30)
  const endFrame = Math.round(
    Number(params.overrides['hf-media.timing.end'] ?? motionDurationFrames(params) / 30) * 30,
  )
  const duration = (endFrame - startFrame) / 30
  return {
    start: startFrame / 30,
    end: endFrame / 30,
    duration,
    sourceEnd: params.sourceIn + duration * params.speed,
  }
}

export function assertMotionSourceDuration(params: MotionParams, sourceDuration: number): void {
  const window = motionMediaWindow(params)
  if (!Number.isFinite(sourceDuration) || sourceDuration + 1 / 30 < window.sourceEnd)
    throw new MotionError(
      'motion_invalid_input',
      'Video source is shorter than the selected in-point, speed and visible media slot',
    )
}
