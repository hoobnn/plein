import type { Engine } from '@plein/canvas-core'
import { adoptResult, currentResult, setParam } from '@plein/doc'
import {
  STAGE_TYPE,
  STAGE_BLOCKS,
  STAGE_POSES,
  type StageBlock,
  type StageBlockKind,
  type StageCamera,
  type StageFigure,
  type StageScene,
  stageSceneOf,
  recordStageKeyframe,
  sampleStageScene,
  stageTime,
  STAGE_KEYFRAME_LIMIT,
} from '@plein/nodes'
import { useEffect, useRef, useState } from 'react'
import { assetUrls } from '../../api/client'
import { useDocVersion } from '../../canvas/hooks'
import { importFiles, revealImports } from '../../canvas/import'
import { useCanvas } from '../../stores/canvas'
import { Icon } from '../../ui/icons'
import { Modal, ModalHeader } from '../../ui/Modal'
import { useClosing } from '../../ui/Presence'
import { Segmented } from '../../ui/Segmented'
import { Slider } from '../../ui/Slider'
import { saveSnapshot } from './snapshot'
import { stageRecordsOf } from './records'
import { applyStageHistory, canStageHistory, writeStageEdit } from './history'
import { stageObjectName, stageObjectPosition } from './placement'
import { type StageMode, type StageTool, StageView } from './view'
import { downloadBlenderStage } from './blender'
import { BlockInspector, CameraInspector, FigureInspector } from './StageInspectors'
import { AddBlock, OutlineGroup, OutlineItem } from './StageOutline'
import { continuousGroup, FIGURE_COLORS, uid } from './stage.utils'

const CAMERA_ID = 'camera'

/** 3D 构图编辑器：左边列对象，中间是取景，右边改选中的对象；截图写成节点的新结果 */
export function StagePanel({
  engine,
  id,
  onClose,
}: {
  engine: Engine
  id: string
  onClose(): void
}) {
  useDocVersion(engine.doc)
  const notify = useCanvas((s) => s.notify)
  const closing = useClosing()
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const timeRef = useRef(time)
  timeRef.current = time
  const playingRef = useRef(playing)
  playingRef.current = playing
  const target = useRef(engine.doc.elementMaps.get(id))
  const isTarget = () =>
    engine.doc.elementMaps.get(id) === target.current &&
    target.current?.get('nodeType') === STAGE_TYPE
  const canWrite = () => {
    const state = useCanvas.getState()
    return (
      !engine.doc.readOnly &&
      !engine.doc.get(id)?.locked &&
      !playingRef.current &&
      isTarget() &&
      state.engine === engine &&
      state.stage === id
    )
  }
  const el = engine.doc.get(id)
  const readOnly = engine.doc.readOnly || !!el?.locked
  const locked = readOnly || closing || playing
  const baseScene = stageSceneOf(el?.params)
  const scene = sampleStageScene(baseScene, time)
  const records = stageRecordsOf(el)
  const [selected, setSelected] = useState<string | null>(scene.figures[0]?.id ?? null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const [mode, setMode] = useState<StageMode>('shot')
  const [tool, setTool] = useState<StageTool>('move')
  const [busy, setBusy] = useState(false)
  const blenderFile = useRef<HTMLInputElement | null>(null)
  const blenderImport = useRef<AbortController | null>(null)
  useEffect(() => {
    const guard = () => {
      if (
        engine.doc.readOnly ||
        engine.doc.get(id)?.locked ||
        engine.doc.elementMaps.get(id) !== target.current ||
        target.current?.get('nodeType') !== STAGE_TYPE
      )
        blenderImport.current?.abort()
    }
    engine.doc.ydoc.on('afterTransaction', guard)
    const unsubscribe = useCanvas.subscribe((state) => {
      if (state.engine !== engine || state.stage !== id) blenderImport.current?.abort()
    })
    return () => {
      unsubscribe()
      engine.doc.ydoc.off('afterTransaction', guard)
      blenderImport.current?.abort()
    }
  }, [engine, id])
  const capturing = useRef(false)
  const [preview, setPreview] = useState<'loading' | 'ready' | 'error'>('loading')
  const [previewAttempt, retryPreview] = useState(0)
  // 面板挂在弹层里，第一次渲染时节点还没进页面：用回调 ref 拿到再建视口
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const view = useRef<StageView | null>(null)
  // 视口 effect 使用最近一次渲染的场景，宿主变化时才重建 WebGL 上下文
  const latest = useRef(scene)
  latest.current = scene
  const rangeGesture = useRef<{ pointerId: number } | null>(null)

  const [, refreshHistory] = useState(0)
  useEffect(() => {
    const undo = engine.doc.undo
    const refresh = () => refreshHistory((n) => n + 1)
    const finishRange = () => {
      if (!rangeGesture.current) return
      rangeGesture.current = null
      undo.stopCapturing()
    }
    const endRange = (event: PointerEvent) => {
      const gesture = rangeGesture.current
      if (gesture?.pointerId !== event.pointerId) return
      // 让原生滑杆在 pointerup 的默认动作中提交最后一个值，再结束归并。
      queueMicrotask(() => {
        if (rangeGesture.current === gesture) finishRange()
      })
    }
    window.addEventListener('pointerup', endRange, true)
    window.addEventListener('pointercancel', endRange, true)
    window.addEventListener('blur', finishRange)
    undo.stopCapturing()
    undo.on('stack-item-added', refresh)
    undo.on('stack-item-updated', refresh)
    undo.on('stack-item-popped', refresh)
    undo.on('stack-cleared', refresh)
    return () => {
      finishRange()
      window.removeEventListener('pointerup', endRange, true)
      window.removeEventListener('pointercancel', endRange, true)
      window.removeEventListener('blur', finishRange)
      undo.stopCapturing()
      undo.off('stack-item-added', refresh)
      undo.off('stack-item-updated', refresh)
      undo.off('stack-item-popped', refresh)
      undo.off('stack-cleared', refresh)
    }
  }, [engine])

  const readScene = () => stageSceneOf(engine.doc.get(id)?.params)
  const commit = (
    change: (current: StageScene) => StageScene,
    group: string | null = null,
    temporal = false,
  ) => {
    if (!canWrite()) return
    // 属性编辑前先确认当前视角；确认可能同步写入新机位，随后必须重新读文档。
    view.current?.finishCamera()
    const current = readScene()
    let next: StageScene
    try {
      next =
        temporal && current.motion
          ? recordStageKeyframe(
              current,
              timeRef.current,
              change(sampleStageScene(current, timeRef.current)),
            )
          : change(current)
    } catch (error) {
      notify((error as Error).message)
      return
    }
    writeStageEdit(
      engine.doc,
      id,
      () => {
        setParam(engine.doc, id, 'scene', { ...next, rev: current.rev + 1 })
      },
      group && temporal && current.motion
        ? `${group}:time:${stageTime(current, timeRef.current)}`
        : group,
      rangeGesture.current !== null,
    )
  }
  const patchFigure = (fid: string, patch: Partial<StageFigure>) =>
    commit(
      (current) => ({
        ...current,
        figures: current.figures.map((f) => (f.id === fid ? { ...f, ...patch } : f)),
      }),
      continuousGroup(`figure:${fid}`, patch, ['name', 'height', 'facing']),
      Object.keys(patch).every((key) => ['x', 'z', 'facing', 'pose'].includes(key)),
    )
  const patchBlock = (bid: string, patch: Partial<StageBlock>) =>
    commit(
      (current) => ({
        ...current,
        blocks: current.blocks.map((b) => (b.id === bid ? { ...b, ...patch } : b)),
      }),
      continuousGroup(`block:${bid}`, patch, ['name', 'w', 'h', 'd', 'facing']),
    )
  const patchCamera = (patch: Partial<StageCamera>) =>
    commit(
      (current) => ({ ...current, camera: { ...current.camera, ...patch } }),
      continuousGroup('camera', patch, ['focal', 'y']),
      true,
    )

  const history = (direction: 'undo' | 'redo') => {
    if (!canWrite()) return
    view.current?.finishCamera()
    applyStageHistory(engine.doc, id, direction)
  }

  useEffect(() => {
    if (!host) return
    let v: StageView | undefined
    setPreview('loading')
    try {
      v = new StageView(host, {
        readOnly: () => !canWrite(),
        onSelect: (sid) => setSelected(sid),
        onMove: (oid, at) => {
          const s = readScene()
          if (s.figures.some((f) => f.id === oid)) patchFigure(oid, at)
          else patchBlock(oid, at)
        },
        onCamera: (camera) => patchCamera(camera),
      })
      v.setScene(latest.current)
      v.setReadOnly(!canWrite())
      v.setSelected(selectedRef.current === CAMERA_ID ? null : selectedRef.current)
      v.setMode(mode)
      v.setTool(tool)
      view.current = v
      setPreview('ready')
    } catch {
      v?.dispose()
      setPreview('error')
      return
    }
    return () => {
      v?.dispose()
      view.current = null
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- 仅宿主变化或用户重试时重建，回调读取最新文档
  }, [host, previewAttempt])
  useEffect(() => view.current?.setReadOnly(locked), [locked])
  const sceneKey = JSON.stringify(scene)
  useEffect(() => view.current?.setScene(latest.current), [sceneKey])
  useEffect(() => view.current?.setSelected(selected === CAMERA_ID ? null : selected), [selected])
  useEffect(() => view.current?.setMode(mode), [mode])
  useEffect(() => view.current?.setTool(tool), [tool])
  const duration = baseScene.motion?.duration ?? 0
  useEffect(() => {
    setTime((value) => stageTime(baseScene, value))
    if (!duration || closing) setPlaying(false)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- 只在时长变化或面板关闭时约束本地播放头
  }, [duration, closing])
  useEffect(() => {
    if (!playing || !duration) return
    const started = performance.now() - timeRef.current * 1000
    let frame = 0
    const tick = (now: number) => {
      const next = Math.min(duration, (now - started) / 1000)
      setTime(next)
      if (next >= duration) setPlaying(false)
      else frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, duration])
  const seek = (value: number) => {
    view.current?.finishCamera()
    engine.doc.undo.stopCapturing()
    setPlaying(false)
    setTime(stageTime(readScene(), value))
  }

  // 快捷键只作用于当前构图面板，不能穿透输入框或菜单。
  const keys = useRef<(e: KeyboardEvent) => void>(() => {})
  keys.current = (e) => {
    if (e.defaultPrevented || e.isComposing || e.repeat || !canWrite()) return
    const target = e.target
    if (!(target instanceof HTMLElement) || !host?.closest('[role="dialog"]')?.contains(target))
      return
    if (
      target.isContentEditable ||
      target.closest(
        'input, textarea, select, [role="menu"], [role="listbox"], [aria-haspopup="menu"][aria-expanded="true"]',
      )
    )
      return
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const key = e.key.toLowerCase()
      if (key === 'z' || key === 'y') {
        e.preventDefault()
        history(key === 'y' || e.shiftKey ? 'redo' : 'undo')
      }
      return
    }
    if (e.altKey) return
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      removeSelected()
    } else if (e.key === 'w' || e.key === 'W') {
      e.preventDefault()
      setTool('move')
    } else if (e.key === 'e' || e.key === 'E') {
      e.preventDefault()
      setTool('rotate')
    }
  }
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e)
    window.addEventListener('keydown', on, true)
    return () => window.removeEventListener('keydown', on, true)
  }, [])

  const figure = scene.figures.find((f) => f.id === selected)
  const block = scene.blocks.find((b) => b.id === selected)

  const addFigure = () => {
    if (!canWrite()) return
    const current = readScene()
    const n = current.figures.length
    if (n >= 12) return
    const at = stageObjectPosition(current, { x: 0, z: 0, w: 0.68, d: 0.68 })
    if (!at) return notify('附近没有足够的站位，请先挪动已有对象')
    const f: StageFigure = {
      id: uid('fig'),
      name: stageObjectName(current, '人物'),
      color:
        FIGURE_COLORS.find((color) => !current.figures.some((f) => f.color === color)) ??
        FIGURE_COLORS[n % FIGURE_COLORS.length]!,
      ...at,
      facing: 0,
      pose: 'stand',
      height: 1.7,
    }
    commit((current) => ({ ...current, figures: [...current.figures, f] }))
    setSelected(f.id)
  }
  const addBlock = (kind: StageBlockKind) => {
    if (!canWrite()) return
    const current = readScene()
    if (current.blocks.length >= 60) return
    const def = STAGE_BLOCKS.find((b) => b.id === kind)!
    const [w, h, d] = def.size
    const at = stageObjectPosition(current, { x: 0, z: -1.5, w, d })
    if (!at) return notify('附近没有足够的空间，请先挪动已有对象')
    const b: StageBlock = {
      id: uid('blk'),
      kind,
      name: stageObjectName(current, def.label),
      ...at,
      facing: 0,
      w,
      h,
      d,
    }
    commit((current) => ({ ...current, blocks: [...current.blocks, b] }))
    setSelected(b.id)
  }
  const removeSelected = () => {
    if (!canWrite() || !selected || selected === CAMERA_ID) return
    commit((current) => ({
      ...current,
      figures: current.figures.filter((f) => f.id !== selected),
      blocks: current.blocks.filter((b) => b.id !== selected),
    }))
    setSelected(null)
  }
  const close = () => {
    blenderImport.current?.abort()
    view.current?.finishCamera()
    onClose()
  }
  const importBlenderRender = async (file: File | undefined) => {
    if (!file || !canWrite() || blenderImport.current) return
    if (
      !/^(image|video)\//.test(file.type) &&
      !/\.(png|jpe?g|webp|gif|mp4|mov|webm)$/i.test(file.name)
    ) {
      notify('请选择 Blender 导出的图片或视频')
      return
    }
    const rect = engine.doc.worldRect(id)
    if (!rect) return
    const controller = new AbortController()
    blenderImport.current = controller
    setBusy(true)
    try {
      const result = await importFiles(
        engine,
        [file],
        { x: rect.x + rect.w + 40, y: rect.y + rect.h / 2 },
        undefined,
        {
          signal: controller.signal,
          select: false,
        },
      )
      if (controller.signal.aborted || !isTarget() || !canWrite()) return
      if (!result.created.length) {
        notify(`导入失败：${result.skipped[0]?.reason ?? '无法识别该文件'}`)
        return
      }
      notify('已将 Blender 渲染结果添加到画布')
      onClose()
      revealImports(engine, result.created)
    } catch (error) {
      if (!controller.signal.aborted) notify(`导入失败：${(error as Error).message}`)
    } finally {
      if (blenderImport.current === controller) blenderImport.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const shoot = async () => {
    const v = view.current
    if (!v || capturing.current || !canWrite()) return
    capturing.current = true
    setBusy(true)
    const report = (message: string) => {
      if (useCanvas.getState().engine === engine && isTarget()) notify(message)
    }
    try {
      // PNG 编码是异步的：来源与采用基线在渲染前冻结，不能记录成等待后的新场景。
      v.finishCamera()
      const node = engine.doc.get(id)
      const captured = stageSceneOf(node?.params)
      const baseline = {
        resultId: node ? currentResult(node, 'image')?.id : undefined,
        element: target.current,
      }
      const capturedTime = stageTime(captured, timeRef.current)
      v.setScene(sampleStageScene(captured, capturedTime))
      const blob = await v.snapshot()
      const shot = await saveSnapshot(engine.doc, id, captured, blob, {
        ...baseline,
        time: captured.motion ? capturedTime : undefined,
      })
      report(
        shot.adopted
          ? `已截图（第 ${shot.rev} 版场景），下游连线用这张`
          : `已截图（第 ${shot.rev} 版场景），保存为候选，当前采用的画面未改变`,
      )
    } catch (err) {
      report(`截图没有成功：${(err as Error).message}`)
    } finally {
      capturing.current = false
      setBusy(false)
    }
  }

  return (
    <Modal label="3D 构图" onClose={close} className="h-full max-w-none" isolateKeys fullScreen>
      <ModalHeader
        title={el?.name ?? '3D 构图'}
        onClose={close}
        meta={<span className="ui-chip">实验</span>}
      >
        <span className="text-xs text-ink-subtle tabular-nums">第 {scene.rev} 版</span>
        <a
          className="ui-btn ui-btn-quiet"
          href="/plein_blender_bridge.py"
          download="plein_blender_bridge.py"
          title="下载 Blender 插件，在 Blender 的插件设置中安装"
        >
          Blender 插件
        </a>
        <button
          type="button"
          className="ui-btn ui-btn-secondary"
          title="导出当前构图和预演关键帧，使用 Plein Blender 插件导入"
          onClick={() => {
            view.current?.finishCamera()
            downloadBlenderStage(el?.name ?? 'Plein 构图', readScene(), timeRef.current)
            notify('已导出 Blender 场景文件；在 Blender 中用 Plein 插件导入')
          }}
        >
          <Icon name="download" size={16} />
          导出到 Blender
        </button>
        <input
          ref={blenderFile}
          type="file"
          accept="image/*,video/*"
          aria-label="选择 Blender 渲染文件"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            void importBlenderRender(file)
          }}
        />
        <button
          type="button"
          className="ui-btn ui-btn-secondary"
          title="将 Blender 导出的图片或视频添加到画布"
          disabled={locked || busy}
          onClick={() => blenderFile.current?.click()}
        >
          {blenderImport.current ? '导入中…' : '导入 Blender 渲染'}
        </button>
        {(['undo', 'redo'] as const).map((direction) => (
          <button
            key={direction}
            type="button"
            className="ui-btn ui-btn-quiet ui-icon-btn"
            aria-label={direction === 'undo' ? '撤销构图操作' : '重做构图操作'}
            title={
              direction === 'undo'
                ? '撤销当前构图操作（⌘/Ctrl Z）'
                : '重做当前构图操作（⌘/Ctrl Shift Z）'
            }
            disabled={locked || !canStageHistory(engine.doc, id, direction)}
            onClick={() => history(direction)}
          >
            <Icon name={direction} size={16} />
          </button>
        ))}
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={preview !== 'ready' || busy || locked}
          aria-busy={busy}
          title="按机位截一张灰模构图，作为这个节点的新结果"
          onClick={() => void shoot()}
        >
          {capturing.current ? (
            <span className="ui-spinner size-3.5" />
          ) : (
            <Icon name="image" size={16} />
          )}
          截图
        </button>
      </ModalHeader>
      {readOnly && (
        <p role="status" className="ui-help px-4 py-2">
          只读构图：可查看对象和切换视角，不能修改场景或截图。
        </p>
      )}
      <div
        className="stage-body"
        onPointerDownCapture={(event) => {
          engine.doc.undo.stopCapturing()
          rangeGesture.current =
            event.button === 0 &&
            event.target instanceof HTMLInputElement &&
            event.target.type === 'range'
              ? { pointerId: event.pointerId }
              : null
        }}
      >
        <aside className="stage-outline ui-scrollbar" aria-label="场景对象">
          <OutlineGroup
            title="人物"
            action={
              <button
                type="button"
                className="ui-btn ui-btn-xs ui-btn-quiet ui-icon-btn"
                aria-label="添加人物"
                title="添加人物"
                disabled={locked || scene.figures.length >= 12}
                onClick={addFigure}
              >
                <Icon name="plus" size={14} />
              </button>
            }
          >
            {scene.figures.map((f) => (
              <OutlineItem
                key={f.id}
                active={selected === f.id}
                onClick={() => setSelected(f.id)}
                swatch={f.color}
                label={f.name}
                extra={STAGE_POSES.find((p) => p.id === f.pose)?.label}
              />
            ))}
          </OutlineGroup>
          <OutlineGroup
            title="场景件"
            action={<AddBlock onPick={addBlock} disabled={locked || scene.blocks.length >= 60} />}
          >
            {scene.blocks.length === 0 && (
              <p className="stage-empty">墙、桌椅、门、床，用来定空间</p>
            )}
            {scene.blocks.map((b) => (
              <OutlineItem
                key={b.id}
                active={selected === b.id}
                onClick={() => setSelected(b.id)}
                icon="cube"
                label={b.name ?? STAGE_BLOCKS.find((k) => k.id === b.kind)?.label ?? '方块'}
              />
            ))}
          </OutlineGroup>
          <OutlineGroup title="机位">
            <OutlineItem
              active={selected === CAMERA_ID}
              onClick={() => setSelected(CAMERA_ID)}
              icon="video"
              label={`${scene.camera.focal}mm · ${scene.aspect}`}
            />
          </OutlineGroup>
          {records.length > 0 && (
            <OutlineGroup title={`截图（${records.length}）`}>
              {records.some((r) => r.adopted && !r.snapshot) && (
                <p className="stage-empty" role="status">
                  当前采用截图缺少构图来源，仍可作为输出使用。
                </p>
              )}
              <div className="stage-shots">
                {records.map((record, index) => (
                  <figure
                    key={record.key}
                    className="stage-shot"
                    data-active={record.adopted || undefined}
                  >
                    <button
                      type="button"
                      aria-pressed={record.adopted}
                      disabled={!record.available || !canWrite()}
                      title={
                        !record.available
                          ? '候选不可用，仅能恢复场景'
                          : record.snapshot
                            ? `第 ${record.snapshot.rev} 版 · ${sampleStageScene(record.snapshot.scene, record.snapshot.time ?? 0).camera.focal}mm · ${record.snapshot.scene.aspect}，点一下让下游用这张`
                            : '采用此截图（缺少构图来源，不能恢复场景）'
                      }
                      onClick={() => {
                        if (!record.available || !canWrite()) return
                        view.current?.finishCamera()
                        const result = engine.doc
                          .get(id)
                          ?.results?.find((r) => r.id === record.resultId)
                        if (
                          result?.port !== 'image' ||
                          result?.value.type !== 'image' ||
                          result.value.assetId !== record.assetId
                        )
                          return
                        writeStageEdit(engine.doc, id, () =>
                          adoptResult(engine.doc, id, record.resultId),
                        )
                      }}
                    >
                      <img
                        loading="lazy"
                        src={assetUrls.variant(record.assetId, 'thumb-256')}
                        alt={
                          record.snapshot
                            ? `第 ${record.snapshot.rev} 版截图`
                            : `第 ${index + 1} 张截图（来源缺失）`
                        }
                      />
                    </button>
                    <figcaption>
                      <span className="tabular-nums">
                        {record.snapshot ? `第 ${record.snapshot.rev} 版` : '来源缺失'}
                        {record.snapshot?.time !== undefined &&
                          ` · ${record.snapshot.time.toFixed(2)}s`}
                      </span>
                      <button
                        type="button"
                        className="stage-link"
                        disabled={!record.snapshot || locked}
                        title={
                          record.snapshot
                            ? '把场景和机位恢复成截这张图时的样子'
                            : '没有保存可恢复的构图来源'
                        }
                        onClick={() => {
                          const captured = record.snapshot?.scene
                          if (captured && canWrite()) {
                            commit(() => captured)
                            setTime(record.snapshot?.time ?? 0)
                          }
                        }}
                      >
                        恢复
                      </button>
                    </figcaption>
                    {record.issue && (
                      <p className="stage-record-note">
                        {record.issue === 'missing'
                          ? '缺少来源，不能恢复场景。'
                          : record.issue === 'removed'
                            ? '候选已移除，可恢复后重新截图。'
                            : '与候选不匹配，可恢复后重新截图。'}
                      </p>
                    )}
                  </figure>
                ))}
              </div>
            </OutlineGroup>
          )}
        </aside>

        <section className="stage-viewport" aria-label="取景">
          <div ref={setHost} className="stage-host" data-mode={mode} />
          {preview !== 'ready' && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-surface p-4 text-center">
              {preview === 'error' ? (
                <>
                  <p role="alert">3D 预览未能加载，请重试。若仍失败，请检查浏览器的图形加速。</p>
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary"
                    onClick={() => retryPreview((attempt) => attempt + 1)}
                  >
                    重试预览
                  </button>
                </>
              ) : (
                <p role="status">正在加载 3D 预览…</p>
              )}
            </div>
          )}
          <div className="stage-overlay stage-overlay-top">
            <Segmented
              label="视角"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'shot', label: '机位视角', icon: 'video' },
                { value: 'free', label: '自由视角', icon: 'map' },
              ]}
            />
            {!readOnly && (figure || block) && (
              <Segmented
                label="操作"
                value={tool}
                onChange={setTool}
                iconOnly
                options={[
                  { value: 'move', label: '移动（W）', icon: 'cursor' },
                  { value: 'rotate', label: '旋转（E）', icon: 'retry' },
                ]}
              />
            )}
          </div>
          <p className="stage-overlay stage-hint">
            {playing
              ? '本地预演中，暂停后可以继续编辑'
              : readOnly
                ? '只读预览 · 可拖动画面查看空间，视角变化不会保存'
                : mode === 'shot'
                  ? '拖动画面绕着看向的点转机位 · 右键平移 · 滚轮推拉 · 点人物或场景件后拖手柄摆位置'
                  : '自由视角只用来摆场景，截图总是按机位取景'}
          </p>
        </section>

        <aside className="stage-inspector ui-scrollbar" aria-label="属性">
          <fieldset key={locked ? 'readonly' : 'editable'} disabled={locked} className="min-w-0">
            {figure ? (
              <FigureInspector
                key={figure.id}
                figure={figure}
                onChange={(p) => patchFigure(figure.id, p)}
                onRemove={removeSelected}
                onAim={() =>
                  patchCamera({
                    tx: figure.x,
                    ty: Math.round(figure.height * 0.85 * 100) / 100,
                    tz: figure.z,
                  })
                }
              />
            ) : block ? (
              <BlockInspector
                key={block.id}
                block={block}
                onChange={(p) => patchBlock(block.id, p)}
                onRemove={removeSelected}
              />
            ) : (
              <CameraInspector
                scene={scene}
                mode={mode}
                onAspect={(aspect) => commit((current) => ({ ...current, aspect }))}
                onChange={patchCamera}
                onFromView={() => {
                  const cam = view.current?.viewAsCamera()
                  if (cam) patchCamera(cam)
                  setMode('shot')
                }}
              />
            )}
          </fieldset>
        </aside>
      </div>
      <section
        aria-label="动态预演"
        className="flex flex-none flex-col gap-2 border-t border-line p-3"
      >
        {!baseScene.motion ? (
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              disabled={locked}
              onClick={() => commit((current) => recordStageKeyframe(current, 0))}
            >
              启用动态预演
            </button>
            <p className="ui-help">记录人物站位、朝向、姿态和机位，在本机预览并按时刻截图。</p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-btn-sm"
                disabled={closing}
                onClick={() => {
                  view.current?.finishCamera()
                  if (!playing && time >= duration) setTime(0)
                  setMode('shot')
                  setPlaying((value) => !value)
                }}
              >
                {playing ? '暂停预演' : '播放预演'}
              </button>
              <label className="flex items-center gap-2 text-xs">
                时长（秒）
                <input
                  aria-label="预演时长"
                  type="number"
                  min={1}
                  max={60}
                  step={0.1}
                  className="ui-input w-20"
                  value={duration}
                  disabled={locked}
                  onChange={(event) => {
                    const value = event.currentTarget.valueAsNumber
                    if (!Number.isFinite(value) || value < 1 || value > 60) return
                    if (baseScene.motion!.keyframes.some((frame) => frame.time > value))
                      return notify('请先移除超过新时长的关键帧')
                    commit(
                      (current) => ({
                        ...current,
                        motion: { ...current.motion!, duration: value },
                      }),
                      'motion:duration',
                    )
                  }}
                />
              </label>
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-btn-sm"
                disabled={
                  locked ||
                  (baseScene.motion.keyframes.length >= STAGE_KEYFRAME_LIMIT &&
                    !baseScene.motion.keyframes.some(
                      (frame) => frame.time === stageTime(baseScene, time),
                    ))
                }
                onClick={() => commit((current) => recordStageKeyframe(current, time))}
              >
                记录当前关键帧
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-quiet ui-btn-sm"
                disabled={
                  locked ||
                  baseScene.motion.keyframes.length <= 1 ||
                  !baseScene.motion.keyframes.some(
                    (frame) => frame.time === stageTime(baseScene, time),
                  )
                }
                onClick={() =>
                  commit((current) => ({
                    ...current,
                    motion: {
                      ...current.motion!,
                      keyframes: current.motion!.keyframes.filter(
                        (frame) => frame.time !== stageTime(current, time),
                      ),
                    },
                  }))
                }
              >
                删除当前关键帧
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-quiet ui-btn-sm"
                disabled={locked}
                onClick={() =>
                  commit((current) => ({ ...sampleStageScene(current, time), motion: undefined }))
                }
              >
                保留当前静态构图
              </button>
              <span className="ui-help">
                站位、朝向、姿态和机位更新当前时刻；人物外观和场景件保持静态。
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Slider
                aria-label="预演时间"
                className="min-w-0 flex-1"
                min={0}
                max={duration}
                step={0.01}
                value={time}
                disabled={closing}
                onValueChange={seek}
              />
              <span
                role="timer"
                aria-live="off"
                aria-label="当前预演时间"
                className="w-28 text-right text-xs tabular-nums"
              >
                {time.toFixed(2)} / {duration.toFixed(2)} 秒
              </span>
            </div>
            <div className="flex flex-wrap gap-1" aria-label="关键帧列表">
              {baseScene.motion.keyframes.map((frame) => (
                <button
                  key={frame.id}
                  type="button"
                  className="ui-btn ui-btn-quiet ui-btn-xs tabular-nums"
                  aria-label={`跳到 ${frame.time.toFixed(2)} 秒关键帧`}
                  aria-pressed={stageTime(baseScene, time) === frame.time}
                  onClick={() => seek(frame.time)}
                >
                  {frame.time.toFixed(2)}s
                </button>
              ))}
            </div>
          </>
        )}
      </section>
    </Modal>
  )
}
