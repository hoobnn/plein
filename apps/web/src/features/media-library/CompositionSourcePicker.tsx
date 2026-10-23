import type { CompositionSourceRef } from '@plein/plugin-sdk'
import type { Asset } from '@plein/protocol'
import { useEffect, useRef, useState } from 'react'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Presence } from '../../ui/Presence'
import { Select } from '../../ui/Select'
import { loadMediaCompositionSources, type MediaCompositionSource } from './composition'

type Choice = {
  id: number
  name: string
  sources: MediaCompositionSource[]
  finish(source?: CompositionSourceRef): void
}

/** 多份工程可生成同一媒体哈希；用户选择后才能把这份明确身份带进画布。 */
export function useCompositionSourcePicker(scope: unknown, enabled: boolean, context?: unknown) {
  const [queue, setQueue] = useState<Choice[]>([])
  const next = useRef(0)
  const lifetime = useRef({ active: true })
  const controllers = useRef(new Set<AbortController>())
  const pending = useRef(new Set<Choice>())
  useEffect(() => {
    const session = { active: true }
    lifetime.current = session
    const activeControllers = controllers.current
    const activeChoices = pending.current
    return () => {
      session.active = false
      for (const controller of activeControllers) controller.abort()
      for (const choice of activeChoices) choice.finish()
      setQueue([])
    }
  }, [scope, context])
  const resolve = async (asset: Asset): Promise<CompositionSourceRef | undefined> => {
    const session = lifetime.current
    const controller = new AbortController()
    controllers.current.add(controller)
    try {
      const sources = await loadMediaCompositionSources(asset.id, controller.signal)
      if (!session.active || controller.signal.aborted)
        throw new DOMException('来源选择已结束', 'AbortError')
      if (sources.length < 2) return sources[0]?.compositionSource
      return await new Promise<CompositionSourceRef>((accept, reject) => {
        const choice: Choice = {
          id: ++next.current,
          name: asset.name,
          sources,
          finish(source) {
            pending.current.delete(choice)
            setQueue((current) => current.filter((entry) => entry !== choice))
            if (source) accept(source)
            else reject(new DOMException('已取消源工程选择', 'AbortError'))
          },
        }
        pending.current.add(choice)
        setQueue((current) => [...current, choice])
      })
    } finally {
      controllers.current.delete(controller)
    }
  }
  const choice = queue[0]
  return {
    resolve,
    picker: (
      <Presence>
        {choice && <Picker key={choice.id} choice={choice} disabled={!enabled} />}
      </Presence>
    ),
  }
}

function Picker({ choice, disabled }: { choice: Choice; disabled: boolean }) {
  const [selected, setSelected] = useState(choice.sources[0]!.compositionSource.manifestAssetId)
  return (
    <Modal
      label="选择素材源版本"
      onClose={() => choice.finish()}
      top
      isolateKeys
      className="max-w-lg"
    >
      <ModalHeader title="选择素材源版本" onClose={() => choice.finish()} />
      <div className="flex flex-col gap-4 p-5">
        <p className="text-sm text-ink-muted">
          「{choice.name}」关联多个可编辑源工程，选择随素材保存的版本。
        </p>
        <Select
          aria-label="可编辑源版本"
          value={selected}
          onChange={setSelected}
          options={choice.sources.map((source, index) => ({
            value: source.compositionSource.manifestAssetId,
            label: `${source.title || '动态合成'} · 版本 ${index + 1}`,
          }))}
        />
        <button
          type="button"
          className="ui-btn ui-btn-primary self-end"
          disabled={disabled}
          onClick={() => {
            const source = choice.sources.find(
              (entry) => entry.compositionSource.manifestAssetId === selected,
            )
            if (source) choice.finish(source.compositionSource)
          }}
        >
          放入此源版本
        </button>
      </div>
    </Modal>
  )
}
