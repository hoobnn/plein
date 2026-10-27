import { Camera } from '@plein/canvas-core'
import { expect, it, vi } from 'vite-plus/test'
import { followPreviewCamera } from './previewCamera'

function setup() {
  const camera = new Camera()
  camera.setViewport(900, 600)
  const rect = { x: 100, y: 200, w: 500, h: 250 }
  const zoomToFit = vi.fn((_: unknown, padding: number | undefined) => camera.fit(rect, padding))
  const follow = followPreviewCamera({ camera, zoomToFit })
  follow.fit()
  return { camera, zoomToFit, ...follow }
}

it('首次适应与连续缩小容器都容纳完整内容，小容器不沿用大留白', () => {
  const f = setup()
  for (const [width, height] of [
    [320, 160],
    [1100, 700],
    [240, 120],
  ]) {
    f.camera.setViewport(width!, height!)
    const top = f.camera.worldToScreen(100, 200)
    const bottom = f.camera.worldToScreen(600, 450)
    expect(top.x).toBeGreaterThanOrEqual(0)
    expect(top.y).toBeGreaterThanOrEqual(0)
    expect(bottom.x).toBeLessThanOrEqual(width!)
    expect(bottom.y).toBeLessThanOrEqual(height!)
  }
  expect(f.zoomToFit).toHaveBeenLastCalledWith(undefined, 15)
  f.dispose()
})

it('手动浏览后 resize 保留缩放和世界中心，重新适应后恢复跟随并可解绑', () => {
  const f = setup()
  f.camera.zoomAt(100, 100, 1.5)
  f.camera.panBy(40, 20)
  const center = f.camera.center,
    zoom = f.camera.zoom
  f.camera.setViewport(350, 250)
  expect(f.camera.center).toEqual(center)
  expect(f.camera.zoom).toBe(zoom)
  expect(f.zoomToFit).toHaveBeenCalledTimes(1)
  f.fit()
  f.camera.setViewport(700, 400)
  expect(f.zoomToFit).toHaveBeenCalledTimes(3)
  f.dispose()
  f.camera.setViewport(300, 200)
  expect(f.zoomToFit).toHaveBeenCalledTimes(3)
})
