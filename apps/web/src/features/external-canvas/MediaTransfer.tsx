import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { externalMediaPath, type ExternalTarget, type RemoteMedia } from '@plein/protocol'
import { useState } from 'react'
import { json, request } from '../../api/http'
import { mediaApi } from '../media-library/client'
import { Select } from '../../ui/Select'

export async function transferMedia(
  canvasId: string,
  ref: ExternalTarget,
  media: RemoteMedia,
  localAssetId?: string,
) {
  return request(
    externalMediaPath(canvasId, localAssetId ? 'replace' : 'import'),
    json('POST', { ...ref, nodeId: media.nodeId, assetId: media.assetId, localAssetId }),
  )
}

export function MediaTransfer({
  canvasId,
  target,
  nodeId,
  busy,
  onTransfer,
}: {
  canvasId: string
  target: ExternalTarget
  nodeId: string
  busy: boolean
  onTransfer(media: RemoteMedia, localAssetId?: string): void
}) {
  const [chosen, setChosen] = useState('')
  const [picking, setPicking] = useState(false)
  const media = useQuery({
    queryKey: ['external-media', canvasId, target.provider, target.target],
    queryFn: ({ signal }) =>
      request<RemoteMedia[]>(externalMediaPath(canvasId, 'list'), {
        ...json('POST', { provider: target.provider, target: target.target }),
        signal,
      }),
    retry: false,
    refetchOnWindowFocus: false,
  })
  const candidates = media.data?.filter((m) => m.nodeId === nodeId) ?? []
  const item =
    candidates.length === 1 ? candidates[0] : candidates.find((m) => m.assetId === chosen)
  if (media.isError)
    return (
      <p className="mt-3 text-xs text-ink-muted">
        即梦素材暂时无法读取。{' '}
        <button type="button" onClick={() => void media.refetch()} className="ui-btn ui-btn-xs">
          重试
        </button>
      </p>
    )
  if (!candidates.length) return null
  return (
    <section className="mt-5 space-y-2 border-t border-line pt-3" aria-label="即梦媒体素材">
      <h4 className="text-sm font-medium">即梦媒体素材</h4>
      {candidates.length > 1 ? (
        <Select
          value={chosen}
          aria-label="即梦候选素材"
          disabled={busy}
          className="max-w-full"
          onChange={(value) => {
            setChosen(value)
            setPicking(false)
          }}
          options={[
            { value: '', label: `选择素材（${candidates.length} 个候选）` },
            ...candidates.map((m) => ({
              value: m.assetId,
              label: `${m.title || m.kind} · ${m.assetId}`,
            })),
          ]}
        />
      ) : (
        <p className="text-xs text-ink-muted wrap-anywhere">
          {item?.title} · {item?.assetId}
        </p>
      )}
      {item && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm"
            disabled={busy || media.isFetching}
            onClick={() => onTransfer(item)}
          >
            将此素材导入 Plein
          </button>
          {item.replaceable && (
            <button
              type="button"
              disabled={busy || media.isFetching}
              className="ui-btn ui-btn-secondary ui-btn-sm"
              onClick={() => setPicking(!picking)}
              aria-expanded={picking}
            >
              选择 Plein 素材替换
            </button>
          )}
        </div>
      )}
      {item?.replaceable && picking && (
        <LocalAssetPicker
          key={item.assetId}
          kind={item.kind}
          busy={busy || media.isFetching}
          action="替换即梦当前素材"
          onSave={(id) => onTransfer(item, id)}
        />
      )}
    </section>
  )
}

function LocalAssetPicker({
  kind,
  busy,
  action,
  onSave,
}: {
  kind: RemoteMedia['kind']
  busy: boolean
  action: string
  onSave(assetId: string): void
}) {
  const [localId, setLocalId] = useState('')
  const local = useInfiniteQuery({
    queryKey: ['external-local-assets', kind],
    queryFn: ({ pageParam, signal }) => mediaApi.list({ kind, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  })
  const asset = local.data?.pages.flatMap((p) => p.items).find((a) => a.id === localId)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label="Plein 素材"
        value={localId}
        disabled={busy || local.isLoading}
        className="max-w-full"
        options={[
          { value: '', label: local.isLoading ? '正在读取素材…' : '选择同类型素材' },
          ...(local.data?.pages.flatMap((p) => p.items) ?? []).map((a) => ({
            value: a.id,
            label: `${a.name || a.kind} · ${a.id.slice(0, 8)}`,
          })),
        ]}
        onChange={setLocalId}
      />
      {local.hasNextPage && (
        <button
          type="button"
          className="ui-btn ui-btn-sm"
          disabled={busy || local.isFetching}
          onClick={() => void local.fetchNextPage()}
        >
          更多素材
        </button>
      )}
      {local.isError ? (
        <button
          type="button"
          className="ui-btn ui-btn-sm"
          disabled={busy}
          onClick={() => void local.refetch()}
        >
          重新读取 Plein 素材
        </button>
      ) : (
        asset && (
          <button
            type="button"
            className="ui-btn ui-btn-primary ui-btn-sm"
            disabled={busy}
            onClick={() => onSave(asset.id)}
          >
            {action}
          </button>
        )
      )}
      {local.isSuccess && local.data.pages[0]?.items.length === 0 && (
        <p className="text-xs text-ink-muted">Plein 暂无同类型素材</p>
      )}
    </div>
  )
}

const mediaKinds = [
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
]
export function PublishMedia({
  busy,
  onPublish,
}: {
  busy: boolean
  onPublish(assetId: string): void
}) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<RemoteMedia['kind']>('image')
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        aria-expanded={open}
        disabled={busy}
        className="ui-btn ui-btn-secondary ui-btn-sm"
        onClick={() => setOpen(!open)}
      >
        导出 Plein 素材
      </button>
      {open && (
        <>
          <Select
            value={kind}
            aria-label="导出素材类型"
            options={mediaKinds}
            disabled={busy}
            onChange={(v) => setKind(v as RemoteMedia['kind'])}
          />
          <LocalAssetPicker
            key={kind}
            kind={kind}
            busy={busy}
            action="保存到即梦画布"
            onSave={onPublish}
          />
        </>
      )}
    </div>
  )
}

export function publishMedia(canvasId: string, target: ExternalTarget, localAssetId: string) {
  return request<{ nodeId: string; assetId: string }>(
    externalMediaPath(canvasId, 'publish'),
    json('POST', { ...target, localAssetId }),
  )
}
