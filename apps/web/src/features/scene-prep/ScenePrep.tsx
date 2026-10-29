import type { Engine } from '@plein/canvas-core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { assetUrls } from '../../api/client'
import { useDocVersion } from '../../canvas/hooks'
import { useCanvas } from '../../stores/canvas'
import { EmptyState } from '../../ui/EmptyState'
import { Icon } from '../../ui/icons'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Presence } from '../../ui/Presence'
import { saveCardToLibrary } from '../library/canvas'
import { useLibrary } from '../library/store'
import {
  scenePrep,
  type ScenePrepAmbiguousShot,
  type ScenePrepContinuity,
  type ScenePrepMissingShot,
  type ScenePrepShot,
} from './model'

export function ScenePrep() {
  const engine = useCanvas((s) => s.engine)
  const sceneId = useCanvas((s) => s.scenePrep)
  return (
    <Presence>
      {engine && sceneId && (
        <ScenePrepContent
          key={`${engine.doc.ydoc.guid}:${sceneId}`}
          engine={engine}
          sceneId={sceneId}
        />
      )}
    </Presence>
  )
}

function ScenePrepContent({ engine, sceneId }: { engine: Engine; sceneId: string }) {
  const version = useDocVersion(engine.doc)
  const [opening, setOpening] = useState(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const localAssets = useCanvas((s) => s.localAssetUrls)
  // oxlint-disable react-hooks/exhaustive-deps -- version 变化即文档变化，重算当前场景准备模型
  const model = useMemo(() => scenePrep(engine.doc, sceneId), [engine, sceneId, version])
  // oxlint-enable react-hooks/exhaustive-deps
  const close = () => useCanvas.getState().openScenePrep(null)
  if (!model)
    return (
      <Modal label="场景准备" onClose={close} isolateKeys className="max-w-xl">
        <ModalHeader title="场景准备" onClose={close} />
        <EmptyState title="场景已不存在" fill />
      </Modal>
    )

  const thumb = (assetId: string) =>
    localAssets?.get(assetId) ?? assetUrls.variant(assetId, 'thumb-256')
  const editViews = async () => {
    if (opening) return
    const canvasId = useCanvas.getState().canvasId
    const currentEngine = () => useCanvas.getState().engine === engine
    const active = () => mounted.current && currentEngine()
    if (!active()) return
    if (!canvasId) {
      useCanvas.getState().notify('打不开场景编辑：当前画布尚未保存')
      return
    }
    setOpening(true)
    try {
      const lib = useLibrary.getState()
      await lib.load()
      if (!active()) return
      const loadError = useLibrary.getState().error
      if (loadError) throw new Error(loadError)
      const current = engine.doc.get(sceneId)
      if (!current) throw new Error('来源卡片已删除')
      const rawLibraryId = current.params?.libraryId
      const libraryId = typeof rawLibraryId === 'string' && rawLibraryId ? rawLibraryId : undefined
      const linked = useLibrary.getState().items.find((item) => item.id === libraryId)
      if (libraryId && !linked) throw new Error('关联的资产库条目已删除')
      const item =
        linked ??
        (
          await saveCardToLibrary(engine, current, lib.projectId, useLibrary.getState(), {
            canvasId,
            current: currentEngine,
          })
        ).item
      if (active()) {
        useLibrary.getState().edit(item)
        close()
      }
    } catch (err) {
      if (active()) useCanvas.getState().notify(`打不开场景编辑：${(err as Error).message}`)
    } finally {
      if (mounted.current) setOpening(false)
    }
  }
  const openShot = (shot: ScenePrepShot) =>
    useCanvas.getState().openShotWorkbench({ boardId: shot.boardId, shotId: shot.shotId })

  return (
    <Modal
      label={`场景准备：${model.name}`}
      onClose={close}
      isolateKeys
      className="h-full max-w-6xl"
    >
      <ModalHeader
        title={`场景准备 · ${model.name}`}
        meta={<span className="text-xs text-ink-subtle">{model.views.length} 个视角</span>}
        onClose={close}
      >
        {model.views.length > 0 && (
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm"
            disabled={opening}
            onClick={() => void editViews()}
          >
            {opening ? '打开中…' : '编辑视角'}
          </button>
        )}
      </ModalHeader>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {(model.description || model.references.length > 0) && (
          <section className="space-y-3 border-b border-line px-5 py-4" aria-label="场景设定">
            {model.description && (
              <p className="text-sm whitespace-pre-wrap text-ink-muted">{model.description}</p>
            )}
            {model.references.length > 0 && (
              <ul className="flex flex-wrap gap-2" aria-label="场景基础参考图">
                {model.references.slice(0, 4).map((assetId) => (
                  <li key={assetId}>
                    <img
                      src={thumb(assetId)}
                      alt="场景基础参考图"
                      className="h-20 w-28 rounded-lg border border-line bg-canvas object-cover"
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        <div className="space-y-5 p-5">
          <details className="text-xs text-ink-subtle">
            <summary className="w-fit cursor-pointer">说明</summary>
            <p className="mt-2">空间关系以创作者记录为准。</p>
          </details>
          {model.views.length === 0 ? (
            <EmptyState
              title="还没有命名视角"
              fill
              action={
                <button
                  type="button"
                  className="ui-btn ui-btn-primary"
                  disabled={opening}
                  onClick={() => void editViews()}
                >
                  {opening ? '打开中…' : '编辑视角'}
                </button>
              }
            />
          ) : (
            <div className="grid items-start gap-4 lg:grid-cols-2">
              {model.views.map(({ view, shots }) => (
                <section
                  key={view.id}
                  aria-label={`视角：${view.name}`}
                  className="overflow-hidden rounded-xl border border-line"
                >
                  {view.images[0] && (
                    <img
                      src={thumb(view.images[0])}
                      alt={`${view.name}视角参考图`}
                      className="h-36 w-full border-b border-line bg-canvas object-cover"
                    />
                  )}
                  <div className="space-y-3 p-4">
                    <div className="flex items-baseline gap-2">
                      <h3 className="min-w-0 flex-1 text-base font-semibold break-words">
                        {view.name}
                      </h3>
                      <span className="flex-none text-xs text-ink-subtle">{shots.length} 镜</span>
                    </div>
                    {view.description && (
                      <p className="text-sm whitespace-pre-wrap text-ink-muted">
                        {view.description}
                      </p>
                    )}
                    <ShotList shots={shots} onOpen={openShot} empty="还没有镜头使用" />
                  </div>
                </section>
              ))}
            </div>
          )}
          {model.unspecified.length > 0 && (
            <ShotGroup title="未指定视角" shots={model.unspecified} onOpen={openShot} />
          )}
          {model.ambiguous.length > 0 && (
            <ShotGroup title="引用不唯一" shots={model.ambiguous} onOpen={openShot} />
          )}
          {model.missing.length > 0 && (
            <ShotGroup title="视角不存在" shots={model.missing} onOpen={openShot} />
          )}
        </div>
      </div>
    </Modal>
  )
}

function ShotGroup({
  title,
  shots,
  onOpen,
}: {
  title: string
  shots: Array<ScenePrepShot | ScenePrepAmbiguousShot | ScenePrepMissingShot>
  onOpen(shot: ScenePrepShot): void
}) {
  return (
    <section aria-label={title} className="rounded-xl border border-line p-4">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex-1 text-sm font-semibold">{title}</h3>
        <span className="text-xs text-ink-subtle">{shots.length} 镜</span>
      </div>
      <ShotList shots={shots} onOpen={onOpen} />
    </section>
  )
}

function ShotList({
  shots,
  onOpen,
  empty,
}: {
  shots: Array<ScenePrepShot | ScenePrepAmbiguousShot | ScenePrepMissingShot>
  onOpen(shot: ScenePrepShot): void
  empty?: string
}) {
  if (!shots.length) return empty ? <p className="text-xs text-ink-subtle">{empty}</p> : null
  return (
    <ul className="space-y-2">
      {shots.map((shot) => (
        <li key={`${shot.boardId}:${shot.shotId}`}>
          <button
            type="button"
            title="打开镜头工作台，编辑镜头目的与起止状态"
            className="flex w-full items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:border-accent hover:bg-accent-soft"
            onClick={() => onOpen(shot)}
          >
            <span className="min-w-0 flex-1 space-y-1.5">
              <span className="block text-sm font-medium">
                {shot.boardName} · 镜头 {shot.no}
              </span>
              {'references' in shot &&
                shot.references.map((problem) => (
                  <span
                    key={`${problem.viewName}:${problem.reference}`}
                    className="block text-xs break-all text-warning"
                  >
                    未匹配「{problem.viewName || '空视角'}」 · 原文：{problem.reference}
                  </span>
                ))}
              {'ambiguities' in shot &&
                shot.ambiguities.map((problem) => (
                  <span
                    key={`${problem.problem}:${problem.reference}`}
                    className="block text-xs break-all text-warning"
                  >
                    {problem.problem} · 原文：{problem.reference}
                  </span>
                ))}
              <ContinuitySummary continuity={shot.continuity} />
            </span>
            <span className="mt-1 flex-none text-ink-subtle">
              <Icon name="chevronRight" size={14} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function ContinuitySummary({ continuity }: { continuity: ScenePrepContinuity }) {
  if (continuity.state === 'conflict')
    return <span className="block text-xs text-warning">计划有并发修订</span>
  if (continuity.state === 'none' || continuity.subjects.length === 0)
    return <span className="block text-xs text-ink-subtle">未记录站位</span>
  return (
    <span className="block space-y-1">
      {continuity.subjects.map((subject) => {
        const position =
          subject.start === subject.end
            ? subject.start
            : `${subject.start ?? '未记录'} → ${subject.end ?? '未记录'}`
        const pose =
          subject.startPose === subject.endPose
            ? subject.startPose
            : [
                subject.startPose && `开始：${subject.startPose}`,
                subject.endPose && `结束：${subject.endPose}`,
              ]
                .filter(Boolean)
                .join(' → ')
        return (
          <span key={subject.subjectId} className="block text-xs break-words text-ink-muted">
            {subject.label} · {position ?? '未记录站位'}
            {pose && ` · 姿势：${pose}`}
          </span>
        )
      })}
    </span>
  )
}
