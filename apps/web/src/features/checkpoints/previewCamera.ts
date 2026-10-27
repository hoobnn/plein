import type { Engine } from '@plein/canvas-core'

/** 适应模式跟随容器尺寸；手动浏览后保持查看中心与缩放。 */
export function followPreviewCamera(engine: Pick<Engine, 'camera' | 'zoomToFit'>) {
  const camera = engine.camera
  const snapshot = () => ({
    width: camera.width,
    height: camera.height,
    x: camera.x,
    y: camera.y,
    zoom: camera.zoom,
    center: camera.center,
  })
  let previous = snapshot(),
    followingFit = true,
    adjusting = false
  const fit = () => {
    adjusting = true
    followingFit = true
    engine.zoomToFit(undefined, Math.min(32, camera.width / 8, camera.height / 8))
    previous = snapshot()
    adjusting = false
  }
  const dispose = camera.onChange(() => {
    if (adjusting) return
    if (camera.width !== previous.width || camera.height !== previous.height) {
      if (followingFit) fit()
      else {
        adjusting = true
        camera.lookAt(previous.center.x, previous.center.y, previous.zoom)
        previous = snapshot()
        adjusting = false
      }
    } else {
      if (camera.x !== previous.x || camera.y !== previous.y || camera.zoom !== previous.zoom)
        followingFit = false
      previous = snapshot()
    }
  })
  return { fit, dispose }
}
