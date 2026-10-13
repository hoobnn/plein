import { assetUrls } from '../api/client'
import { useCanvas } from '../stores/canvas'
import { Icon } from '../ui/icons'

/** 全屏查看图片 / 视频：点空白处或 Esc 关闭 */
export function Viewer() {
  const viewer = useCanvas((s) => s.viewer)
  const view = useCanvas((s) => s.view)
  if (!viewer) return null
  const src = assetUrls.original(viewer.assetId)
  return (
    <div
      role="dialog"
      aria-label={`查看「${viewer.name}」`}
      className="fixed inset-0 z-50 flex items-center justify-center p-10"
      onKeyDown={(e) => {
        if (e.key === 'Escape') view(null)
      }}
    >
      <button
        type="button"
        aria-label="关闭"
        tabIndex={-1}
        onClick={() => view(null)}
        className="absolute inset-0 cursor-default bg-black/85 backdrop-blur-sm"
      />
      {viewer.kind === 'image' ? (
        <img
          src={src}
          alt={viewer.name}
          className="relative max-h-full max-w-full rounded-md object-contain"
        />
      ) : (
        // oxlint-disable-next-line jsx-a11y/media-has-caption -- 生成的视频没有字幕轨
        <video src={src} controls autoPlay className="relative max-h-full max-w-full rounded-md" />
      )}
      <button
        type="button"
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- 打开即可按 Esc 关闭
        autoFocus
        aria-label="关闭"
        onClick={() => view(null)}
        className="absolute top-5 right-5 flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
      >
        <Icon name="x" size={20} />
      </button>
    </div>
  )
}
