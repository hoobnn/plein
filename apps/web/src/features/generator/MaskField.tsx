import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, setParam } from '@plein/doc'
import { EditMask } from '@plein/nodes'
import { useState } from 'react'
import { assetUrls } from '../../api/client'
import type { Upstream } from '../../canvas/nodes'
import { Icon } from '../../ui/icons'
import { Presence } from '../../ui/Presence'
import { MaskEditor } from './MaskEditor'

/**
 * 局部重绘节点的重绘区域：原图缩略图上叠着高亮的区域，点按钮打开画板重画。
 * 原图换了以后旧区域对不上，提示重画。
 */
export function MaskField({
  engine,
  el,
  source,
}: {
  engine: Engine
  el: CanvasElement
  /** 连进来的原图 */
  source?: Upstream
}) {
  const [open, setOpen] = useState(false)
  const parsed = EditMask.safeParse(el.params?.mask)
  const mask = parsed.success ? parsed.data : null
  const v = source?.value
  const assetId = v?.type === 'image' ? v.assetId : undefined
  const stale = !!mask && !!assetId && !!mask.sourceAssetId && mask.sourceAssetId !== assetId
  const readOnly = engine.doc.readOnly
  return (
    <div className="flex items-center gap-3 px-4 pt-3" data-testid="mask-field">
      {mask && assetId ? (
        <button
          type="button"
          className="relative size-12 flex-none overflow-hidden rounded-md bg-surface-2 shadow-1"
          title="重画区域"
          disabled={readOnly}
          onClick={() => setOpen(true)}
        >
          <img
            src={assetUrls.variant(assetId, 'thumb-256')}
            alt=""
            className="size-full object-cover"
          />
          <span
            aria-hidden="true"
            className="absolute inset-0 bg-accent opacity-60"
            style={{
              maskImage: `url(${assetUrls.original(mask.assetId)})`,
              maskMode: 'luminance',
              maskSize: 'cover',
              maskPosition: 'center',
            }}
          />
        </button>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs">
        <span className="text-ink-muted">重绘区域</span>
        <span className={stale ? 'text-warning' : 'text-ink-subtle'}>
          {!assetId
            ? '先连入一张原图'
            : !mask
              ? '还没画：框选或涂抹要改的地方'
              : stale
                ? '原图换过了，区域要重画'
                : `${mask.width}×${mask.height}，高亮处会被重画`}
        </span>
      </div>
      {assetId && !readOnly && (
        <button
          type="button"
          className={`ui-btn ui-btn-sm ${mask && !stale ? 'ui-btn-secondary' : 'ui-btn-primary'}`}
          onClick={() => setOpen(true)}
        >
          <Icon name="regionEdit" size={14} />
          {mask ? '重画区域' : '画区域'}
        </button>
      )}
      <Presence>
        {open && assetId && (
          <MaskEditor
            assetId={assetId}
            name={el.name ?? '局部重绘'}
            initial={stale ? null : mask}
            onClose={() => setOpen(false)}
            onSave={(next) => {
              setOpen(false)
              setParam(engine.doc, el.id, 'mask', next)
            }}
          />
        )}
      </Presence>
    </div>
  )
}
