import type { Engine } from '@plein/canvas-core'
import type { CanvasElement } from '@plein/doc'
import { CHARACTER_IMAGE_SLOTS } from '@plein/nodes'
import type { CharacterImageSlot, LibraryItem } from '@plein/protocol'
import { useEffect, useRef, useState } from 'react'
import { ApiError, api, assetUrls } from '../../api/client'
import { useCanvas } from '../../stores/canvas'
import { Icon } from '../../ui/icons'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Presence } from '../../ui/Presence'
import { Select } from '../../ui/Select'
import {
  type CharacterArchiveSource,
  characterArchiveBody,
  characterArchiveSource,
  sameCharacterArchiveSource,
} from './CharacterProduction'
import { useLibrary } from './store'

const slotLabel = (slot: string) =>
  CHARACTER_IMAGE_SLOTS.find((entry) => entry.id === slot)?.label ?? slot

export function CharacterImageArchiveButton({
  engine,
  el,
  canvasId,
}: {
  engine: Engine
  el: CanvasElement
  canvasId: string | null
}) {
  const source = characterArchiveSource(el, canvasId)
  if (!source) return null
  return (
    <CharacterImageArchiveAction key={JSON.stringify(source)} engine={engine} source={source} />
  )
}

function CharacterImageArchiveAction({
  engine,
  source,
}: {
  engine: Engine
  source: CharacterArchiveSource
}) {
  const [preparing, setPreparing] = useState(false)
  const [item, setItem] = useState<LibraryItem | null>(null)
  const opening = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      opening.current += 1
    }
  }, [])
  const sourceIsCurrent = () => {
    const current = useCanvas.getState()
    return (
      current.engine === engine &&
      current.canvasId === source.canvasId &&
      sameCharacterArchiveSource(engine.doc.get(source.nodeId), source)
    )
  }
  const open = async () => {
    if (preparing || !sourceIsCurrent()) return
    const ticket = ++opening.current
    setPreparing(true)
    try {
      const latest = await api.libraryItem(source.libraryId)
      if (!mounted.current || ticket !== opening.current || !sourceIsCurrent()) return
      if (latest.kind !== 'character') throw new Error('目标不是角色，请重新选择归档目标')
      setItem(latest)
    } catch (error) {
      if (mounted.current && ticket === opening.current)
        useCanvas.getState().notify(`无法读取原角色：${(error as Error).message}`)
    } finally {
      if (mounted.current && ticket === opening.current) setPreparing(false)
    }
  }
  return (
    <>
      <button
        type="button"
        className="ui-btn ui-btn-quiet ui-btn-sm"
        aria-label="归档到角色"
        aria-busy={preparing}
        disabled={preparing}
        title="把当前已采用候选归档到制作时绑定的角色"
        onClick={() => void open()}
      >
        <Icon name="library" size={14} />
        {preparing ? '读取角色…' : '归档到角色'}
      </button>
      <Presence>
        {item && (
          <ArchiveDialog
            source={source}
            item={item}
            sourceIsCurrent={sourceIsCurrent}
            onClose={() => setItem(null)}
          />
        )}
      </Presence>
    </>
  )
}

function ArchiveDialog({
  source,
  item,
  sourceIsCurrent,
  onClose,
}: {
  source: CharacterArchiveSource
  item: LibraryItem
  sourceIsCurrent(): boolean
  onClose(): void
}) {
  const [slot, setSlot] = useState<CharacterImageSlot>(source.slot)
  const [cover, setCover] = useState(item.coverAssetId === source.assetId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflicted, setConflicted] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const confirm = async () => {
    if (busy || conflicted) return
    if (!sourceIsCurrent()) {
      setConflicted(true)
      setError('当前画布、制作目标或已采用候选已变化。请关闭后重新打开归档界面。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const saved = await useLibrary
        .getState()
        .archiveCharacterImage(source.libraryId, characterArchiveBody(source, item, slot, cover))
      if (!mounted.current) return
      onClose()
      if (sourceIsCurrent())
        useCanvas.getState().notify(`已归档到「${saved.name}」的${slotLabel(slot)}`)
    } catch (cause) {
      if (!mounted.current) return
      const conflict = cause instanceof ApiError && cause.status === 409
      setConflicted(conflict)
      setError(
        conflict
          ? `${(cause as Error).message}。请关闭后重新打开，读取最新角色并再次确认。`
          : (cause as Error).message,
      )
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <Modal label="归档到角色" onClose={onClose} top isolateKeys className="max-w-lg">
      <ModalHeader title="归档到角色" onClose={onClose} />
      <div className="ui-scrollbar flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <span className="text-ink-subtle">原角色</span>
          <span className="font-medium" data-library-id={item.id}>
            {item.name}
          </span>
          <span className="text-ink-subtle">制作意图</span>
          <span>{slotLabel(source.slot)}</span>
        </div>
        <img
          src={assetUrls.variant(source.assetId, 'thumb-1024')}
          alt={`${item.name}的当前候选图`}
          className="max-h-72 w-full rounded-xl border border-line object-contain bg-surface-2"
        />
        <p className="break-all text-xs text-ink-subtle">当前采用候选：{source.resultId}</p>
        <Select
          aria-label="目标槽位"
          value={slot}
          disabled={busy || conflicted}
          options={CHARACTER_IMAGE_SLOTS.map((entry) => ({ value: entry.id, label: entry.label }))}
          onChange={(value) => setSlot(value as CharacterImageSlot)}
        />
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={cover}
            disabled={busy || conflicted}
            onChange={(event) => setCover(event.target.checked)}
          />
          <span>
            设为独立封面
            <span className="mt-1 block text-xs text-ink-subtle">
              只改变资产库展示封面，不改变全身定妆图的含义；不勾选则保留原封面。
            </span>
          </span>
        </label>
        <p className="text-xs text-ink-subtle">
          归档只更新「{item.name}
          」的图片与封面。被替换槽位的原图保留为其他参考，不会自动提交新的生成。
        </p>
        {error && (
          <p role="alert" className="rounded-lg bg-danger/5 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
      </div>
      <footer className="flex flex-none justify-end gap-2 border-t border-line px-5 py-3">
        <button type="button" className="ui-btn ui-btn-secondary" onClick={onClose}>
          关闭
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={busy || conflicted}
          aria-busy={busy}
          onClick={() => void confirm()}
        >
          {busy ? '正在归档…' : conflicted ? '请重新核对' : '确认归档'}
        </button>
      </footer>
    </Modal>
  )
}
