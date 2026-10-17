import type { Engine } from '@plein/canvas-core'
import { adoptResult, currentResult, setParam } from '@plein/doc'
import {
  STAGE_ASPECTS,
  STAGE_BLOCKS,
  STAGE_BOUNDS,
  STAGE_POSES,
  type StageAspect,
  type StageBlock,
  type StageBlockKind,
  type StageCamera,
  type StageFigure,
  type StageScene,
  stageSceneOf,
} from '@plein/nodes'
import { Menu } from '@base-ui/react/menu'
import { useEffect, useRef, useState } from 'react'
import { assetUrls } from '../../api/client'
import { useDocVersion } from '../../canvas/hooks'
import { useCanvas } from '../../stores/canvas'
import { Icon } from '../../ui/icons'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Segmented } from '../../ui/Segmented'
import { saveSnapshot } from './snapshot'
import { stageRecordsOf } from './records'
import { applyStageHistory, canStageHistory, writeStageEdit } from './history'
import { stageObjectName, stageObjectPosition } from './placement'
import { type StageMode, type StageTool, StageView } from './view'

/** 人物颜色：灰模上区分人物，优先使用未占用的颜色 */
const FIGURE_COLORS = ['#7aa2ff', '#ff8a7a', '#6fd3a8', '#f2c14e', '#b18cff', '#5cc8e0']

/** 常用焦距：广角到长焦 */
const FOCALS = [18, 24, 35, 50, 85, 135]

const CAMERA_ID = 'camera'

/** 焦距对应的大致景别感，帮人对上分镜里的说法 */
const focalHint = (f: number) =>
  f < 22 ? '超广角' : f < 32 ? '广角' : f < 60 ? '标准' : f < 110 ? '中长焦' : '长焦'

const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`
const continuousGroup = (prefix: string, patch: object, fields: readonly string[]) => {
  const keys = Object.keys(patch)
  return keys.length === 1 && fields.includes(keys[0]!) ? `${prefix}:${keys[0]}` : null
}

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
  const el = engine.doc.get(id)
  const scene = stageSceneOf(el?.params)
  const records = stageRecordsOf(el)
  const [selected, setSelected] = useState<string | null>(scene.figures[0]?.id ?? null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const [mode, setMode] = useState<StageMode>('shot')
  const [tool, setTool] = useState<StageTool>('move')
  const [busy, setBusy] = useState(false)
  // 面板挂在弹层里，第一次渲染时节点还没进页面：用回调 ref 拿到再建视口
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const view = useRef<StageView | null>(null)
  // 视口 effect 使用最近一次渲染的场景，宿主变化时才重建 WebGL 上下文
  const latest = useRef(scene)
  latest.current = scene

  const [, refreshHistory] = useState(0)
  useEffect(() => {
    const undo = engine.doc.undo
    const refresh = () => refreshHistory((n) => n + 1)
    undo.stopCapturing()
    undo.on('stack-item-added', refresh)
    undo.on('stack-item-updated', refresh)
    undo.on('stack-item-popped', refresh)
    undo.on('stack-cleared', refresh)
    return () => {
      undo.stopCapturing()
      undo.off('stack-item-added', refresh)
      undo.off('stack-item-updated', refresh)
      undo.off('stack-item-popped', refresh)
      undo.off('stack-cleared', refresh)
    }
  }, [engine])

  const readScene = () => stageSceneOf(engine.doc.get(id)?.params)
  const commit = (change: (current: StageScene) => StageScene, group: string | null = null) => {
    // 属性编辑前先确认当前视角；确认可能同步写入新机位，随后必须重新读文档。
    view.current?.finishCamera()
    const current = readScene()
    writeStageEdit(
      engine.doc,
      id,
      () => setParam(engine.doc, id, 'scene', { ...change(current), rev: current.rev + 1 }),
      group,
    )
  }
  const patchFigure = (fid: string, patch: Partial<StageFigure>) =>
    commit(
      (current) => ({
        ...current,
        figures: current.figures.map((f) => (f.id === fid ? { ...f, ...patch } : f)),
      }),
      continuousGroup(`figure:${fid}`, patch, ['name', 'height', 'facing']),
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
    )

  const history = (direction: 'undo' | 'redo') => {
    view.current?.finishCamera()
    applyStageHistory(engine.doc, id, direction)
  }

  useEffect(() => {
    if (!host) return
    const v = new StageView(host, {
      onSelect: (sid) => setSelected(sid),
      onMove: (oid, at) => {
        const s = readScene()
        if (s.figures.some((f) => f.id === oid)) patchFigure(oid, at)
        else patchBlock(oid, at)
      },
      onCamera: (camera) => patchCamera(camera),
    })
    view.current = v
    v.setScene(latest.current)
    v.setSelected(selectedRef.current === CAMERA_ID ? null : selectedRef.current)
    return () => {
      v.dispose()
      view.current = null
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- 视口只随宿主节点建一次，回调都经 latest 取最新场景
  }, [host])
  const sceneKey = JSON.stringify(scene)
  useEffect(() => view.current?.setScene(latest.current), [sceneKey])
  useEffect(() => view.current?.setSelected(selected === CAMERA_ID ? null : selected), [selected])
  useEffect(() => view.current?.setMode(mode), [mode])
  useEffect(() => view.current?.setTool(tool), [tool])

  // 快捷键只作用于当前构图面板，不能穿透输入框或菜单。
  const keys = useRef<(e: KeyboardEvent) => void>(() => {})
  keys.current = (e) => {
    if (e.defaultPrevented || e.isComposing || e.repeat) return
    const target = e.target
    if (!(target instanceof HTMLElement) || !host?.closest('[role="dialog"]')?.contains(target))
      return
    if (
      target.isContentEditable ||
      target.closest('input, textarea, select, [role="menu"], [role="listbox"]')
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
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  const figure = scene.figures.find((f) => f.id === selected)
  const block = scene.blocks.find((b) => b.id === selected)

  const addFigure = () => {
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
    if (!selected || selected === CAMERA_ID) return
    commit((current) => ({
      ...current,
      figures: current.figures.filter((f) => f.id !== selected),
      blocks: current.blocks.filter((b) => b.id !== selected),
    }))
    setSelected(null)
  }
  const close = () => {
    view.current?.finishCamera()
    onClose()
  }
  const shoot = async () => {
    const v = view.current
    if (!v || busy) return
    setBusy(true)
    try {
      // PNG 编码是异步的：来源与采用基线在渲染前冻结，不能记录成等待后的新场景。
      v.finishCamera()
      const node = engine.doc.get(id)
      const captured = stageSceneOf(node?.params)
      const baseline = { resultId: node ? currentResult(node, 'image')?.id : undefined }
      v.setScene(captured)
      const blob = await v.snapshot()
      const shot = await saveSnapshot(engine.doc, id, captured, blob, baseline)
      notify(
        shot.adopted
          ? `已截图（第 ${shot.rev} 版场景），下游连线用这张`
          : `已截图（第 ${shot.rev} 版场景），保存为候选，当前采用的画面未改变`,
      )
    } catch (err) {
      notify(`截图没有成功：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal label="3D 构图" onClose={close} className="h-full max-w-7xl" isolateKeys>
      <ModalHeader
        title={el?.name ?? '3D 构图'}
        onClose={close}
        meta={<span className="ui-chip">实验</span>}
      >
        <span className="text-xs text-ink-subtle tabular-nums">第 {scene.rev} 版</span>
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
            disabled={!canStageHistory(engine.doc, id, direction)}
            onClick={() => history(direction)}
          >
            <Icon name={direction} size={16} />
          </button>
        ))}
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={busy}
          title="按机位截一张灰模构图，作为这个节点的新结果"
          onClick={() => void shoot()}
        >
          {busy ? <span className="ui-spinner size-3.5" /> : <Icon name="image" size={16} />}
          截图
        </button>
      </ModalHeader>
      <div className="stage-body" onPointerDownCapture={() => engine.doc.undo.stopCapturing()}>
        <aside className="stage-outline ui-scrollbar" aria-label="场景对象">
          <OutlineGroup
            title="人物"
            action={
              <button
                type="button"
                className="ui-btn ui-btn-xs ui-btn-quiet ui-icon-btn"
                aria-label="添加人物"
                title="添加人物"
                disabled={scene.figures.length >= 12}
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
            action={<AddBlock onPick={addBlock} disabled={scene.blocks.length >= 60} />}
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
                      disabled={!record.available || engine.doc.readOnly}
                      title={
                        !record.available
                          ? '候选不可用，仅能恢复场景'
                          : record.snapshot
                            ? `第 ${record.snapshot.rev} 版 · ${record.snapshot.scene.camera.focal}mm · ${record.snapshot.scene.aspect}，点一下让下游用这张`
                            : '采用此截图（缺少构图来源，不能恢复场景）'
                      }
                      onClick={() => {
                        if (!record.available || engine.doc.readOnly) return
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
                      </span>
                      <button
                        type="button"
                        className="stage-link"
                        disabled={!record.snapshot || engine.doc.readOnly}
                        title={
                          record.snapshot
                            ? '把场景和机位恢复成截这张图时的样子'
                            : '没有保存可恢复的构图来源'
                        }
                        onClick={() => {
                          const captured = record.snapshot?.scene
                          if (captured && !engine.doc.readOnly) commit(() => captured)
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
            {(figure || block) && (
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
            {mode === 'shot'
              ? '拖动画面绕着看向的点转机位 · 右键平移 · 滚轮推拉 · 点人物或场景件后拖手柄摆位置'
              : '自由视角只用来摆场景，截图总是按机位取景'}
          </p>
        </section>

        <aside className="stage-inspector ui-scrollbar" aria-label="属性">
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
        </aside>
      </div>
    </Modal>
  )
}

/** 添加场景件：加号弹出种类菜单 */
function AddBlock({ onPick, disabled }: { onPick(kind: StageBlockKind): void; disabled: boolean }) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        aria-label="添加场景件"
        title="添加场景件"
        disabled={disabled}
        className="ui-btn ui-btn-xs ui-btn-quiet ui-icon-btn"
      >
        <Icon name="plus" size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-70"
        >
          <Menu.Popup
            aria-label="添加场景件"
            className="ui-menu pointer-events-auto w-32 outline-none"
          >
            {STAGE_BLOCKS.map((b) => (
              <Menu.Item key={b.id} className="ui-menu-item" onClick={() => onPick(b.id)}>
                {b.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

function OutlineGroup({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="stage-group">
      <header className="stage-group-head">
        <h3 className="ui-section-title">{title}</h3>
        {action}
      </header>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  )
}

function OutlineItem(props: {
  active: boolean
  onClick(): void
  label: string
  extra?: string
  swatch?: string
  icon?: 'cube' | 'video'
}) {
  return (
    <button
      type="button"
      className="stage-item"
      data-active={props.active || undefined}
      aria-pressed={props.active}
      onClick={props.onClick}
    >
      {props.swatch ? (
        <span className="stage-swatch" style={{ background: props.swatch }} />
      ) : (
        <Icon name={props.icon ?? 'cube'} size={14} />
      )}
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.extra && <span className="text-ink-subtle">{props.extra}</span>}
    </button>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="stage-field">
      <span className="stage-field-label">{label}</span>
      <span className="stage-field-control">{children}</span>
    </label>
  )
}

/** 滑杆加数值：拖动时就写入，松手不用再点确定 */
function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit: string
  onChange(v: number): void
}) {
  return (
    <Field label={props.label}>
      <input
        type="range"
        aria-label={props.label}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <span className="stage-value tabular-nums">
        {props.value}
        {props.unit}
      </span>
    </Field>
  )
}

function NumberField(props: {
  label: string
  value: number
  step?: number
  onChange(v: number): void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    setDraft(null)
    if (!draft.trim()) return
    const v = Number(draft)
    if (Number.isFinite(v)) props.onChange(Math.max(-50, Math.min(50, v)))
  }
  return (
    <Field label={props.label}>
      <input
        type="number"
        className="ui-input w-full tabular-nums"
        step={props.step ?? 0.1}
        value={draft ?? props.value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter') e.currentTarget.blur()
          else if (e.key === 'Escape') {
            e.stopPropagation()
            setDraft(null)
          }
        }}
      />
    </Field>
  )
}

function NameField(props: { value: string; onChange(v: string): void }) {
  return (
    <Field label="名字">
      <input
        className="ui-input w-full"
        maxLength={40}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </Field>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="stage-section">
      <h3 className="ui-section-title">{title}</h3>
      {children}
    </section>
  )
}

function FigureInspector(props: {
  figure: StageFigure
  onChange(p: Partial<StageFigure>): void
  onRemove(): void
  onAim(): void
}) {
  const f = props.figure
  return (
    <>
      <Section title="人物">
        <NameField value={f.name} onChange={(name) => props.onChange({ name })} />
        <Field label="颜色">
          <span className="flex gap-1.5">
            {FIGURE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`颜色 ${c}`}
                aria-pressed={f.color === c}
                className="stage-color"
                style={{ background: c }}
                onClick={() => props.onChange({ color: c })}
              />
            ))}
          </span>
        </Field>
        <Slider
          label="身高"
          value={f.height}
          min={0.9}
          max={2.1}
          step={0.01}
          unit=" 米"
          onChange={(height) => props.onChange({ height })}
        />
      </Section>
      <Section title="姿态">
        <div className="stage-poses">
          {STAGE_POSES.map((p) => (
            <button
              key={p.id}
              type="button"
              className="ui-btn ui-btn-sm ui-btn-secondary"
              aria-pressed={f.pose === p.id}
              data-active={f.pose === p.id || undefined}
              onClick={() => props.onChange({ pose: p.id })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <Slider
          label="朝向"
          value={f.facing}
          min={-180}
          max={180}
          step={1}
          unit="°"
          onChange={(facing) => props.onChange({ facing })}
        />
      </Section>
      <Section title="位置">
        <NumberField label="左右" value={f.x} onChange={(x) => props.onChange({ x })} />
        <NumberField label="前后" value={f.z} onChange={(z) => props.onChange({ z })} />
        <div className="flex gap-2">
          <button
            type="button"
            className="ui-btn ui-btn-sm ui-btn-secondary flex-1"
            onClick={props.onAim}
          >
            机位对准
          </button>
          <button type="button" className="ui-btn ui-btn-sm ui-btn-quiet" onClick={props.onRemove}>
            <Icon name="trash" size={14} />
            删除
          </button>
        </div>
      </Section>
    </>
  )
}

function BlockInspector(props: {
  block: StageBlock
  onChange(p: Partial<StageBlock>): void
  onRemove(): void
}) {
  const b = props.block
  const kind = STAGE_BLOCKS.find((k) => k.id === b.kind)?.label ?? '方块'
  const size = (key: 'w' | 'h' | 'd', label: string, max: number) => (
    <Slider
      label={label}
      value={b[key]}
      min={0.05}
      max={max}
      step={0.05}
      unit=" 米"
      onChange={(v) => props.onChange({ [key]: v })}
    />
  )
  return (
    <>
      <Section title={kind}>
        <NameField value={b.name ?? kind} onChange={(name) => props.onChange({ name })} />
        {size('w', '宽', 12)}
        {size('h', '高', 6)}
        {size('d', '深', 12)}
      </Section>
      <Section title="位置">
        <NumberField label="左右" value={b.x} onChange={(x) => props.onChange({ x })} />
        <NumberField label="前后" value={b.z} onChange={(z) => props.onChange({ z })} />
        <Slider
          label="朝向"
          value={b.facing}
          min={-180}
          max={180}
          step={1}
          unit="°"
          onChange={(facing) => props.onChange({ facing })}
        />
        <button
          type="button"
          className="ui-btn ui-btn-sm ui-btn-quiet self-end"
          onClick={props.onRemove}
        >
          <Icon name="trash" size={14} />
          删除
        </button>
      </Section>
    </>
  )
}

function CameraInspector(props: {
  scene: StageScene
  mode: StageMode
  onAspect(a: StageAspect): void
  onChange(p: Partial<StageCamera>): void
  onFromView(): void
}) {
  const c = props.scene.camera
  return (
    <>
      <Section title="画幅">
        <div className="stage-aspects">
          {STAGE_ASPECTS.map((a) => (
            <button
              key={a}
              type="button"
              className="ui-btn ui-btn-sm ui-btn-secondary tabular-nums"
              aria-pressed={props.scene.aspect === a}
              data-active={props.scene.aspect === a || undefined}
              onClick={() => props.onAspect(a)}
            >
              {a}
            </button>
          ))}
        </div>
      </Section>
      <Section title="镜头">
        <Slider
          label="焦距"
          value={c.focal}
          min={12}
          max={200}
          step={1}
          unit="mm"
          onChange={(focal) => props.onChange({ focal })}
        />
        <div className="stage-focals">
          {FOCALS.map((f) => (
            <button
              key={f}
              type="button"
              className="stage-link tabular-nums"
              data-active={c.focal === f || undefined}
              onClick={() => props.onChange({ focal: f })}
            >
              {f}
            </button>
          ))}
          <span className="ml-auto text-ink-subtle">{focalHint(c.focal)}</span>
        </div>
        <Slider
          label="机位高"
          value={c.y}
          min={STAGE_BOUNDS.cameraHeight.min}
          max={STAGE_BOUNDS.cameraHeight.max}
          step={0.05}
          unit=" 米"
          onChange={(y) => props.onChange({ y })}
        />
      </Section>
      {props.mode === 'free' && (
        <Section title="从这里拍">
          <p className="ui-help">把机位放到当前自由视角的位置，看向同一个点。</p>
          <button
            type="button"
            className="ui-btn ui-btn-sm ui-btn-secondary"
            onClick={props.onFromView}
          >
            设为机位
          </button>
        </Section>
      )}
      <p className="ui-help">选中人物后可以「机位对准」，再在机位视角里拖动画面微调。</p>
    </>
  )
}
