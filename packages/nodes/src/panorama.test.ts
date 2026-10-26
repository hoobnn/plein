import { expect, it } from 'vite-plus/test'
import { panoramaSize, projectPanorama, PanoramaPose, isEquirectangular } from './panorama'
import { sceneViewAssets, sceneViewImages } from './sceneViews'

function bands() {
  const data = new Uint8ClampedArray(12 * 6 * 4)
  for (let y = 0; y < 6; y++)
    for (let x = 0; x < 12; x++) {
      const color = x < 4 ? [255, 0, 0] : x < 8 ? [0, 0, 255] : [255, 255, 0]
      data.set([...color, 255], (y * 12 + x) * 4)
    }
  return data
}
it.each([
  [0, [0, 0, 255, 255]],
  [90, [255, 255, 0, 255]],
  [-90, [255, 0, 0, 255]],
] as const)('朝向%s°按球面经度投影正确方向，而非同一块平面裁剪', (yaw, expected) => {
  expect([...projectPanorama(bands(), 12, 6, { yaw, pitch: 0, fov: 55 }, 1, 1)]).toEqual(expected)
})
it('跨越全景经度接缝时连续采样，朝向±180°相同', () => {
  const pose = { pitch: 0, fov: 55 }
  expect(projectPanorama(bands(), 12, 6, { ...pose, yaw: -180 }, 5, 3)).toEqual(
    projectPanorama(bands(), 12, 6, { ...pose, yaw: 180 }, 5, 3),
  )
})
it('俯仰投影能查看上下方向，画幅和FOV改变实际视野', () => {
  const data = bands()
  for (let x = 0; x < 12; x++)
    for (let y = 0; y < 2; y++) data.set([0, 255, 0, 255], (y * 12 + x) * 4)
  expect([...projectPanorama(data, 12, 6, { yaw: 0, pitch: 60, fov: 55 }, 1, 1)]).toEqual([
    0, 255, 0, 255,
  ])
  expect(projectPanorama(data, 12, 6, { yaw: 0, pitch: 0, fov: 25 }, 8, 4)).not.toEqual(
    projectPanorama(data, 12, 6, { yaw: 0, pitch: 0, fov: 100 }, 8, 4),
  )
  expect(panoramaSize('landscape')).toEqual({ width: 1024, height: 576 })
  expect(panoramaSize('portrait')).toEqual({ width: 576, height: 1024 })
  expect(panoramaSize('square')).toEqual({ width: 1024, height: 1024 })
})
it('限制无效投影尺寸、方向与源像素', () => {
  expect(isEquirectangular(4, 3)).toBe(false)
  expect(isEquirectangular(4001, 2000)).toBe(true)
  const pose = { yaw: 0, pitch: 0, fov: 55 }
  expect(() => projectPanorama(bands(), 6, 12, pose, 1, 1)).toThrow('2:1')
  expect(() => projectPanorama(bands(), 12, 6, pose, 1025, 10)).toThrow('1024')
  expect(() => projectPanorama(bands(), 12, 6, { ...pose, fov: NaN }, 1, 1)).toThrow('参数')
  expect(PanoramaPose.safeParse({ ...pose, format: 'unknown' }).success).toBe(false)
})
it('原全景是强引用，但该命名视角的模型输入只含截图', () => {
  const image = 'a'.repeat(64),
    source = 'b'.repeat(64)
  const views = [
    {
      id: 'view',
      name: '门口',
      aliases: [],
      description: '',
      images: [image],
      panorama: { assetId: source, yaw: 90, pitch: 0, fov: 55, format: 'landscape' },
    },
  ]
  expect(sceneViewImages(views)).toEqual([image])
  expect(sceneViewAssets(views)).toEqual([image, source])
})
