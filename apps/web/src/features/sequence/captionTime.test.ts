import { expect, it } from 'vite-plus/test'
import { captionPreviewTime } from './captionTime'
it('字幕中间逐帧seek，非整帧终点使用宿主规范化末端', () => {
  expect(captionPreviewTime(0.45, 2.02, 61 / 30)).toBe(13 / 30)
  expect(captionPreviewTime(2.02, 2.02, 61 / 30)).toBe(61 / 30)
  expect(captionPreviewTime(3, 2, 2)).toBe(2)
  expect(captionPreviewTime(-1, 2)).toBe(0)
})
