import type { Engine } from '@plein/canvas-core'
import { setParam } from '@plein/doc'
import { resolveShotAsset, shotsOf, writeStoryboardShots } from '@plein/capabilities'
import { planParams, SHOT_SIZES, shotPresets, type Shot } from '@plein/nodes'
import { assetUrls } from '../../api/client'
import { targetImages } from '../../canvas/nodes'
import { useDocVersion } from '../../canvas/hooks'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Icon } from '../../ui/icons'
import { Select } from '../../ui/Select'
import { AssetBindingSelect, DialogueCell } from './ShotBindings'
import { DurationCell, TextCell } from './StoryboardCells'
import { storyboardDataProblem } from './dataRecovery'
import { composeShotPrompts } from './shotFlowModel'

type Stage = 1 | 2 | 3
const movements = shotPresets.filter((p) => p.slot === 'camera.move')
const pad = (n: number) => String(n).padStart(2, '0')

function assetsOf(engine: Engine, shots: Shot[]) {
  const items = new Map<
    string,
    { name: string; el: ReturnType<typeof resolveShotAsset>; shot: Shot; images: string[] }
  >()
  for (const shot of shots)
    for (const name of new Set([
      ...shot.characters,
      ...shot.dialogue.map((d) => d.character).filter(Boolean),
    ])) {
      const el = resolveShotAsset(
        engine.doc,
        name,
        shot.assetBindings?.[name] ?? shot.dialogue.find((d) => d.character === name)?.speaker,
      )
      const key = el?.id ?? `missing:${name}`
      if (!items.has(key))
        items.set(key, { name, el, shot, images: el ? targetImages(engine, el) : [] })
    }
  return [...items.values()]
}

export function ShotFlowHeader({
  engine,
  shots,
  stage,
  onStage,
}: {
  engine: Engine
  shots: Shot[]
  stage: Stage
  onStage(stage: Stage): void
}) {
  const assets = assetsOf(engine, shots)
  const ready = assets.filter((item) => item.images.length).length
  const planned = shots.filter((s) => s.description.trim()).length
  const prompts = shots.filter((s) => s.imagePrompt.trim() && s.motionPrompt.trim()).length
  return (
    <nav
      aria-label="镜头制作流程"
      className="flex shrink-0 items-stretch gap-2 overflow-x-auto border-b border-line px-5 py-4"
    >
      {(
        [
          { id: 1, title: '确认镜头', subtitle: `${planned}/${shots.length} 个镜头已有画面描述` },
          {
            id: 2,
            title: '准备资产',
            subtitle: assets.length
              ? `${ready}/${assets.length} 项已有参考图`
              : '按镜头绑定角色、场景和道具',
          },
          { id: 3, title: '合成提示词', subtitle: `${prompts}/${shots.length} 个镜头已补齐` },
        ] as const
      ).map((step, i) => (
        <div key={step.id} className="flex min-w-0 flex-1 items-center gap-2">
          {i > 0 && (
            <span aria-hidden="true" className="hidden h-px w-8 shrink-0 bg-line sm:block" />
          )}
          <button
            type="button"
            aria-current={stage === step.id ? 'step' : undefined}
            className={`flex min-w-44 flex-1 items-center gap-3 rounded-xl px-3 py-2 text-left ${stage === step.id ? 'bg-surface-2' : 'hover:bg-hover'}`}
            onClick={() => onStage(step.id)}
          >
            <span
              className={`flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-medium ${stage === step.id ? 'bg-ink text-surface' : 'border border-line text-ink-subtle'}`}
            >
              {step.id}
            </span>
            <span>
              <span className="block text-sm font-medium">{step.title}</span>
              <span className="mt-0.5 block text-xs text-ink-subtle">{step.subtitle}</span>
            </span>
          </button>
        </div>
      ))}
    </nav>
  )
}

export function ShotFlow({
  engine,
  boardId,
  shots,
  stage,
  picked,
  onPick,
  onPickAll,
  onPatch,
  onAdd,
  onRemove,
  onPrompts,
  onDetails,
  onNext,
  onLocate,
  onRowRef,
  addRef,
  expanded,
  onExpand,
  onBatch,
}: {
  engine: Engine
  boardId: string
  shots: Shot[]
  stage: Stage
  picked: Set<string>
  onPick(id: string, on: boolean): void
  onPickAll(on: boolean): void
  onPatch(id: string, patch: Partial<Shot> | ((current: Shot) => Partial<Shot>)): void
  onAdd(): void
  onRemove(id: string): void
  onPrompts(id: string): void
  onDetails(id: string): void
  onNext(): void
  onLocate(id: string): void
  onRowRef(id: string, node: HTMLElement | null): void
  addRef: React.RefObject<HTMLButtonElement | null>
  expanded: boolean
  onExpand(): void
  onBatch(): void
}) {
  const read = (id: string) => shotsOf(engine.doc.get(boardId)).find((shot) => shot.id === id)
  const rawStyle = engine.doc.get(boardId)?.params?.visualStyle
  const style = typeof rawStyle === 'string' ? rawStyle : ''
  const assets = assetsOf(engine, shots)
  const ready = assets.filter((item) => item.images.length).length
  const readOnly = engine.doc.readOnly
  const composeMissing = () => {
    const board = engine.doc.get(boardId)
    if (
      readOnly ||
      engine.doc.readOnly ||
      board?.nodeType !== 'plein/storyboard' ||
      storyboardDataProblem(board.params?.shots)
    )
      return
    const latest = shotsOf(board)
    const latestStyle =
      typeof board.params?.visualStyle === 'string' ? board.params.visualStyle : ''
    engine.doc.undo.stopCapturing()
    writeStoryboardShots(
      engine.doc,
      boardId,
      latest.map((shot) => {
        if (picked.size && !picked.has(shot.id)) return shot
        if (shot.imagePrompt.trim() && shot.motionPrompt.trim()) return shot
        const prompt = composeShotPrompts(engine.doc, shot, latestStyle)
        return {
          ...shot,
          imagePrompt: shot.imagePrompt.trim() ? shot.imagePrompt : prompt.imagePrompt,
          motionPrompt: shot.motionPrompt.trim() ? shot.motionPrompt : prompt.motionPrompt,
          edited: true,
        }
      }),
    )
    engine.doc.undo.stopCapturing()
  }
  return (
    <>
      <div className="ui-scrollbar min-h-0 flex-1 overflow-auto" data-testid="shot-flow-content">
        {stage === 2 ? (
          <div className="space-y-7 p-5">
            <TextCell
              label="全局视觉风格"
              value={style}
              readValue={() => String(engine.doc.get(boardId)?.params?.visualStyle ?? '')}
              onChange={(value) => {
                if (!engine.doc.readOnly) setParam(engine.doc, boardId, 'visualStyle', value)
              }}
            />
            {(['角色', '场景', '道具', '其他参考', '待绑定'] as const).map((category) => {
              const group = assets.filter(
                (item) =>
                  (!item.el
                    ? '待绑定'
                    : item.el.nodeType === 'plein/character'
                      ? '角色'
                      : item.el.nodeType === 'plein/scene'
                        ? '场景'
                        : item.el.nodeType === 'plein/prop'
                          ? '道具'
                          : '其他参考') === category,
              )
              if (!group.length) return null
              return (
                <section key={category} aria-label={category}>
                  <h3 className="mb-3 text-sm font-medium">
                    {category} <span className="text-ink-subtle">{group.length}</span>
                  </h3>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 xl:grid-cols-5">
                    {group.map((item) => (
                      <article
                        key={item.el?.id ?? item.name}
                        aria-label={`${item.name}素材`}
                        className="min-w-0"
                      >
                        <button
                          type="button"
                          className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl border border-dashed border-line bg-surface-2 text-xs text-ink-subtle"
                          disabled={!item.el}
                          onClick={() => item.el && onLocate(item.el.id)}
                        >
                          {item.images[0] ? (
                            <img
                              src={assetUrls.variant(item.images[0], 'thumb-256')}
                              alt={item.name}
                              className="size-full object-cover"
                            />
                          ) : (
                            <span>
                              {item.el ? '打开素材节点，生成或上传参考图' : '请先绑定画布素材'}
                            </span>
                          )}
                          {item.images.length > 0 && (
                            <span className="absolute right-2 bottom-2 rounded bg-black/60 px-2 py-1 text-white">
                              {item.images.length} 张参考图
                            </span>
                          )}
                        </button>
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <h4 className="truncate text-sm font-medium">{item.name}</h4>
                          <span
                            className={`shrink-0 text-xs ${item.images.length ? 'text-success' : 'text-ink-subtle'}`}
                          >
                            {item.images.length ? '有参考图' : '待准备'}
                          </span>
                        </div>
                        <AssetBindingSelect
                          engine={engine}
                          name={item.name}
                          binding={item.shot.assetBindings?.[item.name]}
                          onChange={(binding) =>
                            onPatch(item.shot.id, (current) => {
                              const assetBindings = { ...current.assetBindings }
                              if (binding) assetBindings[item.name] = binding
                              else delete assetBindings[item.name]
                              return { assetBindings }
                            })
                          }
                        />
                      </article>
                    ))}
                  </div>
                </section>
              )
            })}
            {!assets.length && (
              <p className="py-12 text-center text-sm text-ink-subtle">
                镜头尚未填写出场资产；在详细卡片中添加角色、场景或道具。
              </p>
            )}
          </div>
        ) : (
          <table
            className="shot-flow-table w-full min-w-[1360px] border-collapse text-sm"
            aria-label="逐镜头分镜表"
          >
            <colgroup>
              {[
                ['number', 72],
                ['duration', 84],
                ['description', 320],
                ['size', 110],
                ['light', 170],
                ['dialogue', 230],
                ['sound', 150],
                ['motion', 180],
                ['prompts', 110],
                ['actions', 72],
              ].map(([key, width]) => (
                <col key={key} style={{ width }} />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-10 bg-surface-2 text-xs text-ink-muted">
              <tr>
                <th scope="col">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      aria-label="全选镜头"
                      checked={shots.length > 0 && picked.size === shots.length}
                      onChange={(e) => onPickAll(e.target.checked)}
                    />
                    镜号
                  </label>
                </th>
                {[
                  '时长',
                  '画面描述',
                  '景别',
                  '光影氛围',
                  '对白 · 旁白',
                  '音效',
                  '运镜',
                  '最终提示词',
                  '操作',
                ].map((label) => (
                  <th scope="col" key={label}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shots.map((shot) => (
                <tr
                  key={shot.id}
                  ref={(node) => onRowRef(shot.id, node)}
                  aria-label={`镜头 ${pad(shot.no)}`}
                  className={
                    picked.has(shot.id) ? 'bg-active' : 'hover:bg-hover focus-within:bg-hover'
                  }
                >
                  <td>
                    <label className="flex items-center gap-2 tabular-nums">
                      <input
                        type="checkbox"
                        aria-label={`选择镜头 ${shot.no}`}
                        checked={picked.has(shot.id)}
                        onChange={(e) => onPick(shot.id, e.target.checked)}
                      />
                      {pad(shot.no)}
                    </label>
                  </td>
                  <td>
                    <DurationCell
                      compact
                      value={shot.duration}
                      onChange={(duration) => onPatch(shot.id, { duration })}
                    />
                  </td>
                  <td>
                    <TextCell
                      compact
                      label="画面"
                      value={shot.description}
                      readValue={() => read(shot.id)?.description ?? ''}
                      onChange={(description) => onPatch(shot.id, { description })}
                    />
                  </td>
                  <td>
                    <Select
                      aria-label={`镜头 ${shot.no} 景别`}
                      value={shot.shotSize}
                      options={SHOT_SIZES.map((value) => ({ value }))}
                      onChange={(value) =>
                        onPatch(shot.id, { shotSize: value as Shot['shotSize'] })
                      }
                    />
                  </td>
                  <td>
                    <TextCell
                      compact
                      label="光影"
                      value={shot.lighting}
                      readValue={() => read(shot.id)?.lighting ?? ''}
                      onChange={(lighting) => onPatch(shot.id, { lighting })}
                    />
                  </td>
                  <td>
                    <DialogueCell
                      compact
                      engine={engine}
                      shot={shot}
                      readDialogue={() => read(shot.id)?.dialogue ?? []}
                      onChange={(update) =>
                        onPatch(shot.id, (current) => ({ dialogue: update(current.dialogue) }))
                      }
                    />
                  </td>
                  <td>
                    <TextCell
                      compact
                      label="音效"
                      value={shot.sfx}
                      readValue={() => read(shot.id)?.sfx ?? ''}
                      onChange={(sfx) => onPatch(shot.id, { sfx })}
                    />
                  </td>
                  <td>
                    <Select
                      aria-label={`镜头 ${shot.no} 运镜预设`}
                      value={
                        movements.find((p) => p.template === shot.cameraMotion)?.id ??
                        (shot.cameraMotion ? '__custom' : '')
                      }
                      options={[
                        { value: '', label: '不指定' },
                        ...(shot.cameraMotion &&
                        !movements.some((p) => p.template === shot.cameraMotion)
                          ? [{ value: '__custom', label: '自定义运镜' }]
                          : []),
                        ...movements.map((p) => ({ value: p.id, label: p.title })),
                      ]}
                      onChange={(id) =>
                        id !== '__custom' &&
                        onPatch(shot.id, {
                          cameraMotion: movements.find((p) => p.id === id)?.template ?? '',
                        })
                      }
                    />
                    <details className="mt-1 text-xs text-ink-subtle">
                      <summary className="cursor-pointer rounded px-2 py-1 hover:bg-hover">
                        自定义运镜
                      </summary>
                      <TextCell
                        compact
                        label="运镜描述"
                        value={shot.cameraMotion ?? ''}
                        readValue={() => read(shot.id)?.cameraMotion ?? ''}
                        onChange={(cameraMotion) => onPatch(shot.id, { cameraMotion })}
                      />
                    </details>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm ui-btn-quiet"
                      onClick={() => onPrompts(shot.id)}
                    >
                      查看提示词
                    </button>
                    <span className="block px-2 text-2xs text-ink-subtle">
                      {shot.imagePrompt.trim() && shot.motionPrompt.trim() ? '已补齐' : '待补齐'}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ui-btn ui-btn-xs ui-btn-quiet"
                      aria-label={`详细编辑镜头 ${shot.no}`}
                      onClick={() => onDetails(shot.id)}
                    >
                      详情
                    </button>
                    <button
                      type="button"
                      disabled={readOnly}
                      className="ui-btn ui-btn-xs ui-btn-quiet ui-icon-btn text-ink-subtle hover:text-danger"
                      aria-label={`删除镜头 ${shot.no}`}
                      onClick={() => onRemove(shot.id)}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
        <div className="flex items-center gap-3">
          <button
            ref={addRef}
            type="button"
            className="ui-btn ui-btn-quiet"
            disabled={readOnly}
            onClick={onAdd}
          >
            <Icon name="plus" size={14} />
            添加镜头
          </button>
          <span className="text-xs text-ink-subtle">
            {stage === 2
              ? `${ready}/${assets.length} 项资产已有参考图`
              : picked.size
                ? `已选择 ${picked.size} 个镜头`
                : `${shots.length} 个镜头 · ${shots.reduce((n, s) => n + s.duration, 0)} 秒`}
          </span>
        </div>
        {stage === 3 ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              disabled={
                readOnly ||
                !shots.some(
                  (s) =>
                    (!picked.size || picked.has(s.id)) &&
                    s.description.trim() &&
                    (!s.imagePrompt.trim() || !s.motionPrompt.trim()),
                )
              }
              onClick={composeMissing}
            >
              {picked.size ? '本地补齐所选提示词' : '本地补齐全部提示词'}
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-secondary"
              disabled={readOnly || !shots.length}
              onClick={expanded ? onBatch : onExpand}
            >
              {expanded ? '查看视频生成清单' : '展开镜头节点'}
            </button>
          </div>
        ) : (
          <button type="button" className="ui-btn ui-btn-primary" onClick={onNext}>
            {stage === 1 ? '下一步：准备资产' : '下一步：合成提示词'}
            <Icon name="chevronRight" size={14} />
          </button>
        )}
      </footer>
    </>
  )
}

export function ShotPromptDialog({
  engine,
  boardId,
  shotId,
  onClose,
  onPatch,
}: {
  engine: Engine
  boardId: string
  shotId: string
  onClose(): void
  onPatch(patch: Partial<Shot>): void
}) {
  useDocVersion(engine.doc)
  const shot = () => shotsOf(engine.doc.get(boardId)).find((s) => s.id === shotId)
  const current = shot()
  const style = String(engine.doc.get(boardId)?.params?.visualStyle ?? '')
  const close = () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    onClose()
  }
  return (
    <Modal label="镜头最终提示词" onClose={close} isolateKeys top className="max-w-4xl">
      <ModalHeader title={`第 ${current?.no ?? '已删除'} 镜 · 最终提示词`} onClose={close} />
      <div className="ui-scrollbar min-h-0 flex-1 space-y-5 overflow-auto p-5">
        {!current ? (
          <p role="alert">镜头已删除，请重新选择。</p>
        ) : (
          <>
            <p className="text-xs text-ink-subtle">
              编辑失焦后自动保存。运镜属于提示词意图，最终效果需审片确认。
            </p>
            <TextCell
              label="分镜图提示词"
              value={current.imagePrompt}
              readValue={() => shot()?.imagePrompt ?? ''}
              onChange={(imagePrompt) => onPatch({ imagePrompt })}
            />
            <TextCell
              label="视频运动提示词"
              value={current.motionPrompt}
              readValue={() => shot()?.motionPrompt ?? ''}
              onChange={(motionPrompt) => onPatch({ motionPrompt })}
            />
            <details>
              <summary className="cursor-pointer text-xs text-ink-subtle">
                查看展开计划中的提示词
              </summary>
              <pre className="mt-2 rounded-lg bg-surface-2 p-3 text-xs whitespace-pre-wrap">
                {String(planParams(current, 'video').prompt)}
              </pre>
            </details>
          </>
        )}
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-5 py-3">
        <span className="text-xs text-ink-subtle">本地拼接，不调用生成平台</span>
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={!current || engine.doc.readOnly}
          onClick={() => {
            const latest = shot()
            if (latest && !engine.doc.readOnly)
              onPatch(composeShotPrompts(engine.doc, latest, style))
          }}
        >
          按当前镜头重新拼接
        </button>
      </footer>
    </Modal>
  )
}
