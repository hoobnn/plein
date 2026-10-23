/** 中间时间按30fps取帧，终点使用宿主量化时长，让end-exclusive字幕完全消失。 */
export function captionPreviewTime(time: number, duration: number, normalized?: number) {
  if (time >= duration) return normalized ?? Math.round(duration * 30) / 30
  return Math.max(0, Math.floor(time * 30 + 1e-6) / 30)
}
