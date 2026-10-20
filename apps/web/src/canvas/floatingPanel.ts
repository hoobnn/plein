/** 把浮动面板放进两侧遮挡之间；anchor 是元素中点或右边缘，均为屏幕坐标。 */
export function fitFloatingPanel(
  anchor: number,
  preferredWidth: number,
  left: number,
  right: number,
  align: 'center' | 'right' = 'center',
) {
  const width = Math.max(1, Math.min(preferredWidth, right - left))
  const desired = anchor - (align === 'right' ? width : width / 2)
  return { width, left: Math.max(left, Math.min(desired, right - width)) }
}

/** 画布工具条可换行：用实际高度避开目标，并限制在两侧面板之间。 */
export function fitCanvasToolbar(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; left: number; right: number },
  align: 'center' | 'right' = 'right',
) {
  const left = viewport.left + 8
  const right = viewport.width - viewport.right - 8
  const panel = fitFloatingPanel(anchor.x, size.width, left, right, align)
  return {
    right: viewport.width - panel.left - panel.width,
    top: Math.max(64, anchor.y - size.height - 8),
    maxWidth: Math.max(1, right - left),
  }
}

/** 底栏与助手并排至少需要 380px；侧栏占用也要算进去。 */
export function canvasBottomSpace(viewportWidth: number, left: number) {
  const available = viewportWidth - left
  // 桌面视图工具栏在剩余内容区 <=680px 时分行（底栏另有 24px 内边距）。
  if (viewportWidth >= 640 && available <= 704) {
    const mascot = available < 360 ? 176 : 128
    return { mascot, generator: mascot + 64 }
  }
  return available < 380 ? { mascot: 64, generator: 128 } : { mascot: 8, generator: 64 }
}
