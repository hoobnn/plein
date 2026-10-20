import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, setParam } from '@plein/doc'
import { EditMask } from '@plein/nodes'
import { useEffect, useState } from 'react'
import { assetUrls } from '../../api/client'
import { upstreams, type Upstream } from '../../canvas/nodes'
import { useCatalog } from '../../stores/catalog'
import { useCanvas } from '../../stores/canvas'
import { Icon } from '../../ui/icons'
import { Presence } from '../../ui/Presence'
import { MaskEditor } from './MaskEditor'

function revision(mask: EditMask | null) {
  return mask
    ? JSON.stringify([mask.assetId, mask.width, mask.height, mask.sourceAssetId ?? null])
    : ''
}

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
  const notify = useCanvas((state) => state.notify)
  const [editing, setEditing] = useState<{
    assetId: string
    initial: EditMask | null
    revision: string
    node: object
  } | null>(null)
  const parsed = EditMask.safeParse(el.params?.mask)
  const mask = parsed.success ? parsed.data : null
  const v = source?.value
  const assetId = v?.type === 'image' ? v.assetId : undefined
  const stale = !!mask && !!assetId && !!mask.sourceAssetId && mask.sourceAssetId !== assetId
  const readOnly = engine.doc.readOnly
  const conflict = !editing
    ? null
    : engine.doc.elementMaps.get(el.id) !== editing.node
      ? '重绘节点已被替换，请重新打开后编辑'
      : revision(mask) !== editing.revision
        ? '重绘区域已更新，请重新打开后编辑'
        : editing.assetId !== assetId
          ? '原图已经变化，请重新画重绘区域'
          : readOnly
            ? '画布已变为只读，重绘区域编辑已关闭'
            : null
  useEffect(() => {
    if (!conflict) return
    setEditing(null)
    notify(conflict)
  }, [conflict, notify])
  const open = () => {
    const node = engine.doc.elementMaps.get(el.id)
    if (!assetId || readOnly || !node) return
    setEditing({
      assetId,
      initial: stale ? null : mask,
      revision: revision(mask),
      node,
    })
  }
  return (
    <div className="flex items-center gap-3 px-4 pt-3" data-testid="mask-field">
      {mask && assetId ? (
        <button
          type="button"
          className="relative size-12 flex-none overflow-hidden rounded-md bg-surface-2 shadow-1"
          title="重画区域"
          disabled={readOnly}
          onClick={open}
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
          onClick={open}
        >
          <Icon name="regionEdit" size={14} />
          {mask ? '重画区域' : '画区域'}
        </button>
      )}
      <Presence>
        {editing && !conflict && assetId && (
          <MaskEditor
            key={assetId}
            assetId={assetId}
            name={el.name ?? '局部重绘'}
            initial={editing.initial}
            onClose={() => setEditing(null)}
            onSave={(next) => {
              if (!engine.doc.has(el.id)) throw new Error('重绘节点已经不在画布上了')
              if (!editing || engine.doc.elementMaps.get(el.id) !== editing.node)
                throw new Error('重绘节点已被替换，请重新打开后编辑')
              const latest = EditMask.safeParse(engine.doc.get(el.id)?.params?.mask)
              if (revision(latest.success ? latest.data : null) !== editing.revision)
                throw new Error('重绘区域已更新，请重新打开后编辑')
              if (engine.doc.readOnly) throw new Error('画布已变为只读，未保存重绘区域')
              const current = upstreams(engine, el.id, useCatalog.getState().catalog).get(
                'image',
              )?.[0]?.value
              if (current?.type !== 'image' || current.assetId !== next.sourceAssetId)
                throw new Error('原图已经变化，请重新画重绘区域')
              setParam(engine.doc, el.id, 'mask', next)
              setEditing(null)
            }}
          />
        )}
      </Presence>
    </div>
  )
}
