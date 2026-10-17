import type { Engine } from '@plein/canvas-core'
import { setParam } from '@plein/doc'
import {
  dropShot,
  newShotId,
  normalizeDialogue,
  SHOT_SIZES,
  type Shot,
  type ShotRole,
} from '@plein/nodes'
import { useEffect, useState } from 'react'
import { useDocVersion } from '../../canvas/hooks'
import { detachShot, expandedNodes, expandShots, planDiffs, shotsOf } from './model'
import type { StoryboardBatchRequest } from '@plein/protocol'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { confirmDialog, dialogOpen } from '../../ui/Dialog'
import { Icon } from '../../ui/icons'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Select } from '../../ui/Select'
import { StoryboardSync } from './StoryboardSync'
import { Presence } from '../../ui/Presence'
import { EmptyState } from '../../ui/EmptyState'
import { StoryboardReview } from './StoryboardReview'
import { BatchChecklist } from './BatchChecklist'
import { openAnimatic } from '../sequence/animatic'
import { AssetBindingSelect, DialogueCell } from './ShotBindings'

const cell =
  'w-full resize-none rounded-md bg-transparent px-2 py-1.5 text-sm text-ink outline-none ring-1 ring-transparent transition-shadow hover:ring-line focus:bg-surface-2 focus:ring-accent'

const splitNames = (text: string) =>
  text
    .split(/[、,，\s]+/)
    .map((s) => s.replace(/^@/, '').trim())
    .filter(Boolean)

/** 分镜表格编辑器：全屏浮层，改单元格即写入文档并标记为手改 */
export function StoryboardEditor() {
  const engine = useCanvas((s) => s.engine)
  const id = useCanvas((s) => s.storyboard)
  const close = () => useCanvas.getState().openStoryboard(null)
  return (
    <Presence>
      {engine && id && engine.doc.get(id) && <Editor engine={engine} id={id} onClose={close} />}
    </Presence>
  )
}

function Editor({ engine, id, onClose }: { engine: Engine; id: string; onClose(): void }) {
  // 协作者改表格也能看到
  useDocVersion(engine.doc)
  const catalog = useCatalog((s) => s.catalog)
  const notify = useCanvas((s) => s.notify)
  const canvasId = useCanvas((s) => s.canvasId)
  const el = engine.doc.get(id)
  const shots = shotsOf(el).map((s) => ({ ...s, dialogue: normalizeDialogue(s.id, s.dialogue) }))
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [syncScope, setSyncScope] = useState<string[] | null>(null)
  const [batchRequest, setBatchRequest] = useState<StoryboardBatchRequest | null>(null)
  const [mode, setMode] = useState<'edit' | 'review'>('edit')
  const expanded = expandedNodes(engine, id)
  const diffs = planDiffs(engine, id)
  const targets = picked.size ? shots.filter((s) => picked.has(s.id)) : shots
  const targetIds = targets.map((s) => s.id)
  /** 每个镜头有出入的字段数：表格改动后在行尾提示 */
  const diffCount = (shotId: string) =>
    (diffs.get(shotId) ?? []).reduce((n, d) => n + d.diffs.length, 0)
  const scopeDiffs = targetIds.reduce((n, sid) => n + diffCount(sid), 0)

  useEffect(() => {
    // 捕获阶段拦下按键：表格打开时画布的快捷键（删除、方向键等）不生效
    const key = (e: KeyboardEvent) => {
      if (useCanvas.getState().viewer) return
      e.stopPropagation()
      // 差异面板或确认框开着时 Esc 关它们，不连带关掉表格
      if (e.key === 'Escape' && !syncScope && !batchRequest && !dialogOpen()) onClose()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose, syncScope, batchRequest])

  const write = (next: Shot[]) => setParam(engine.doc, id, 'shots', next)
  const patch = (shotId: string, p: Partial<Shot>) =>
    write(shots.map((s) => (s.id === shotId ? { ...s, ...p, edited: true } : s)))
  const addShot = () => {
    const no = (shots.at(-1)?.no ?? 0) + 1
    write([
      ...shots,
      {
        id: newShotId(),
        no,
        duration: 5,
        shotSize: '中景',
        description: '',
        characters: [],
        emotion: '',
        lighting: '',
        sfx: '',
        dialogue: [],
        imagePrompt: '',
        motionPrompt: '',
        edited: true,
      },
    ])
  }
  /**
   * 删镜头：只从计划里去掉这一行。已经展开出来的节点和它们的产物留在画布上，
   * 只是标记成脱离计划、不再跟着表格更新；删行和标记在同一次撤销里。
   */
  const remove = async (shotId: string) => {
    const nodes = expanded.get(shotId)?.length ?? 0
    const no = shots.find((s) => s.id === shotId)?.no
    if (nodes > 0) {
      const ok = await confirmDialog({
        title: `删除镜头 ${String(no ?? '').padStart(2, '0')}？`,
        message: `这个镜头已经展开成 ${nodes} 个节点。节点和它们的产物会保留在画布上，只是不再属于当前分镜表；按 Ctrl+Z 可以撤销这次删除。`,
        confirmLabel: '删除镜头',
        danger: true,
      })
      if (!ok) return
    }
    const next = dropShot(shots, shotId)
    engine.doc.ydoc.transact(() => {
      setParam(engine.doc, id, 'shots', next.shots)
      detachShot(engine, id, shotId)
    }, engine.doc.origin)
    engine.doc.flush()
    notify(nodes ? `已删除镜头，${nodes} 个节点保留在画布上（Ctrl+Z 可撤销）` : '已删除镜头')
  }
  const scope = picked.size ? `选中的 ${picked.size} 个镜头` : '全部镜头'

  const expand = (mode: 'new' | 'update') => {
    const { frames, created, updated, skipped, ambiguous, sequence } = expandShots(
      engine,
      id,
      targetIds,
      catalog,
      {
        mode,
      },
    )
    // 重名的角色卡没法判断分镜指的是哪一个，宁可不引用也不能引错
    if (ambiguous.length)
      notify(
        `画布上有重名的资产卡：${ambiguous.join('、')}。先改名或写清是哪一个，这次没有把它们写进提示词`,
      )
    if (mode === 'update')
      notify(
        updated
          ? `已给 ${updated} 个镜头补齐缺的节点（新建 ${created} 个）${skipped ? `，${skipped} 个结构完整没动` : ''}`
          : '这些镜头结构已经完整，已有节点一个参数都没改',
      )
    else {
      const already = targets.filter((s) => expanded.has(s.id)).length
      notify(
        frames.length
          ? `已展开 ${frames.length} 个镜头（${created} 个节点）${already ? `，${already} 个之前展开过，已跳过` : ''}`
          : '这些镜头都已展开过，要补齐用「更新展开」',
      )
    }
    if (sequence === 'ambiguous')
      notify('画布上有多个序列，镜头没有自动接入，请把镜头视频和配音连到要导出的那个序列')
    if (frames.length) {
      onClose()
      engine.zoomToFit([id, ...frames])
    }
  }
  const batch = (role: ShotRole, force = false) => {
    if (!canvasId) {
      notify('请先连接服务再检查批量清单')
      return
    }
    setBatchRequest({ shotIds: targetIds, role, reuseExisting: !force && !picked.size })
  }

  const btn = 'ui-btn ui-btn-secondary'
  return (
    <Modal label="分镜表" onClose={onClose} className="max-w-350">
      <ModalHeader
        title={el?.name ?? '分镜'}
        onClose={onClose}
        meta={
          <span className="ui-chip">
            {shots.length} 个镜头 · {shots.reduce((t, s) => t + s.duration, 0)} 秒
          </span>
        }
      >
        <div role="group" aria-label="分镜视图" className="flex gap-1">
          <button
            type="button"
            className={mode === 'edit' ? 'ui-btn ui-btn-primary' : btn}
            onClick={() => setMode('edit')}
          >
            编辑分镜
          </button>
          <button
            type="button"
            className={mode === 'review' ? 'ui-btn ui-btn-primary' : btn}
            onClick={() => setMode('review')}
          >
            审核镜头
          </button>
        </div>
        <button
          type="button"
          className={btn}
          disabled={!shots.length}
          onClick={() => {
            openAnimatic(engine, id)
            onClose()
          }}
        >
          节奏样片
        </button>
        <span className="mr-1 text-xs text-ink-subtle">作用于{scope}</span>
        <button type="button" className={btn} onClick={addShot}>
          <Icon name="plus" />
          添加镜头
        </button>
        <button
          type="button"
          className={btn}
          disabled={!shots.length}
          onClick={() => expand('new')}
        >
          <Icon name="workflow" />
          展开为节点
        </button>
        <button
          type="button"
          className={btn}
          disabled={!expanded.size}
          title="给已展开的镜头补齐缺的角色和新增的台词，已有节点不动"
          onClick={() => expand('update')}
        >
          <Icon name="retry" />
          更新展开
        </button>
        <span aria-hidden="true" className="ui-bar-sep" />
        <details className="relative">
          <summary className={btn}>全部重新生成</summary>
          <div className="absolute z-20 flex w-44 flex-col gap-1 rounded-lg bg-surface p-2 shadow-3">
            {(['image', 'video', 'speech', 'sfx'] as const).map((role) => (
              <button
                key={role}
                type="button"
                className="ui-btn ui-btn-quiet"
                onClick={() => batch(role, true)}
              >
                {{ image: '分镜图', video: '视频', speech: '配音', sfx: '音效' }[role]}
              </button>
            ))}
          </div>
        </details>
        <button
          type="button"
          className={btn}
          disabled={!expanded.size}
          onClick={() => batch('image')}
        >
          <Icon name="image" />
          批量出分镜图
        </button>
        <button
          type="button"
          className={btn}
          disabled={!expanded.size}
          onClick={() => batch('video')}
        >
          <Icon name="video" />
          批量生成视频
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={!expanded.size}
          onClick={() => batch('speech')}
        >
          <Icon name="mic" />
          批量配音
        </button>
        <button
          type="button"
          className={btn}
          disabled={!expanded.size}
          onClick={() => batch('sfx')}
        >
          批量音效
        </button>
        <button
          type="button"
          className={btn}
          disabled={!scopeDiffs}
          title="看分镜表改动和已展开节点的出入，确认后才同步"
          onClick={() => setSyncScope(targetIds)}
        >
          <Icon name="layers" />
          查看差异{scopeDiffs ? `（${scopeDiffs}）` : ''}
        </button>
        {canvasId && (
          <button
            type="button"
            className={btn}
            disabled={!expanded.size}
            title="改了之后哪些镜头图、视频、配音受影响，保留还是重做"
            onClick={() => {
              onClose()
              useCanvas.getState().toggleImpact(true)
            }}
          >
            <Icon name="layers" />
            查看影响
          </button>
        )}
      </ModalHeader>
      {shots.length === 0 ? (
        <EmptyState
          icon="frames"
          title="还没有镜头"
          hint="把剧本连到分镜节点后点“生成”，或手动添加镜头。"
        />
      ) : mode === 'review' ? (
        <StoryboardReview
          engine={engine}
          boardId={id}
          shots={shots}
          picked={picked}
          onPick={(sid, on) =>
            setPicked((previous) => {
              const next = new Set(previous)
              if (on) next.add(sid)
              else next.delete(sid)
              return next
            })
          }
        />
      ) : (
        <div className="ui-scrollbar min-h-0 overflow-auto">
          <table className="w-full min-w-300 border-collapse text-left text-sm">
            <thead className="sticky top-0 z-10 bg-surface-2 text-xs font-medium text-ink-subtle">
              <tr>
                <th className="w-12 py-2 pl-5 pr-2">
                  <input
                    type="checkbox"
                    aria-label="全选"
                    checked={picked.size > 0 && picked.size === shots.length}
                    onChange={(e) =>
                      setPicked(new Set(e.target.checked ? shots.map((s) => s.id) : []))
                    }
                  />
                </th>
                <th className="w-12 px-2 py-2 font-normal">镜号</th>
                <th className="w-16 px-2 py-2 font-normal">时长</th>
                <th className="w-20 px-2 py-2 font-normal">景别</th>
                <th className="w-32 px-2 py-2 font-normal">光影</th>
                <th className="w-28 px-2 py-2 font-normal">情绪 / 语气</th>
                <th className="w-40 px-2 py-2 font-normal">音效</th>
                <th className="px-2 py-2 font-normal">画面</th>
                <th className="w-32 px-2 py-2 font-normal">出场</th>
                <th className="w-56 px-2 py-2 font-normal">台词（角色：台词）</th>
                <th className="px-2 py-2 font-normal">分镜图提示词</th>
                <th className="w-48 px-2 py-2 font-normal">运动提示词</th>
                <th className="w-20 py-2 pl-2 pr-5" />
              </tr>
            </thead>
            <tbody>
              {shots.map((s) => (
                <tr key={s.id} className="border-t border-line align-top hover:bg-hover">
                  <td className="py-2.5 pl-5 pr-2">
                    <input
                      type="checkbox"
                      aria-label={`选择镜头 ${s.no}`}
                      checked={picked.has(s.id)}
                      onChange={(e) => {
                        const next = new Set(picked)
                        if (e.target.checked) next.add(s.id)
                        else next.delete(s.id)
                        setPicked(next)
                      }}
                    />
                  </td>
                  <td className="px-2 py-2.5 tabular-nums text-ink-muted">
                    {String(s.no).padStart(2, '0')}
                  </td>
                  <td className="px-1 py-1">
                    <input
                      type="number"
                      min={1}
                      max={30}
                      aria-label="时长"
                      className={cell}
                      value={s.duration}
                      onChange={(e) => patch(s.id, { duration: Number(e.target.value) || 1 })}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <Select
                      aria-label="景别"
                      className="h-8 w-full bg-transparent shadow-none hover:bg-hover"
                      value={s.shotSize}
                      options={SHOT_SIZES.map((o) => ({ value: o }))}
                      onChange={(v) => patch(s.id, { shotSize: v as Shot['shotSize'] })}
                    />
                  </td>
                  <TextCell
                    value={s.lighting}
                    label="光影"
                    onChange={(lighting) => patch(s.id, { lighting })}
                  />
                  <TextCell
                    value={s.emotion}
                    label="情绪 / 语气"
                    onChange={(emotion) => patch(s.id, { emotion })}
                  />
                  <TextCell value={s.sfx} label="音效" onChange={(sfx) => patch(s.id, { sfx })} />
                  <TextCell
                    value={s.description}
                    label="画面"
                    onChange={(v) => patch(s.id, { description: v })}
                  />
                  <TextCell
                    value={s.characters.join('、')}
                    label="出场"
                    onChange={(v) => patch(s.id, { characters: splitNames(v) })}
                  >
                    {s.characters.map((name) => (
                      <AssetBindingSelect
                        key={name}
                        engine={engine}
                        name={name}
                        binding={s.assetBindings?.[name]}
                        onChange={(binding) => {
                          const assetBindings = { ...s.assetBindings }
                          if (binding) assetBindings[name] = binding
                          else delete assetBindings[name]
                          patch(s.id, { assetBindings })
                        }}
                      />
                    ))}
                  </TextCell>
                  <DialogueCell
                    engine={engine}
                    shot={s}
                    onChange={(dialogue) => patch(s.id, { dialogue })}
                  />
                  <TextCell
                    value={s.imagePrompt}
                    label="分镜图提示词"
                    onChange={(v) => patch(s.id, { imagePrompt: v })}
                  />
                  <TextCell
                    value={s.motionPrompt}
                    label="运动提示词"
                    onChange={(v) => patch(s.id, { motionPrompt: v })}
                  />
                  <td className="py-2 pr-5 pl-2">
                    <div className="flex flex-col items-end gap-1">
                      <div className="flex items-center gap-1">
                        {expanded.has(s.id) && (
                          <span className="ui-tag ui-tag-success">已展开</span>
                        )}
                        {diffCount(s.id) > 0 && (
                          <button
                            type="button"
                            aria-label={`查看镜头 ${s.no} 的差异`}
                            className="ui-tag ui-tag-warning hover:brightness-110"
                            onClick={() => setSyncScope([s.id])}
                          >
                            {diffCount(s.id)} 处差异
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label={`删除镜头 ${s.no}`}
                          title={expanded.has(s.id) ? '删除镜头（已展开的节点保留）' : '删除镜头'}
                          className="ui-btn ui-btn-xs ui-btn-quiet ui-icon-btn hover:text-danger"
                          onClick={() => void remove(s.id)}
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      </div>
                      {s.edited && <span className="ui-tag ui-tag-accent">手改</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {syncScope && (
        <StoryboardSync
          engine={engine}
          boardId={id}
          shotIds={syncScope}
          onClose={() => setSyncScope(null)}
        />
      )}
      {batchRequest && canvasId && (
        <BatchChecklist
          engine={engine}
          canvasId={canvasId}
          boardId={id}
          request={batchRequest}
          onClose={() => setBatchRequest(null)}
          onLocate={(row) => {
            setBatchRequest(null)
            if (row.nodeId) {
              engine.selection.set([row.nodeId])
              engine.zoomToFit([row.nodeId])
              onClose()
            }
          }}
          onStarted={(total) => {
            setBatchRequest(null)
            notify(`已按清单开始 ${total} 项生成；沿用、阻塞和跳过项保持原状`)
          }}
        />
      )}
    </Modal>
  )
}

/** 单元格：失焦时写入，避免每个按键都改一次文档并标记手改 */
function TextCell({
  value,
  label,
  onChange,
  children,
}: {
  value: string
  label: string
  onChange(v: string): void
  children?: React.ReactNode
}) {
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setDraft(value)
  }, [value, focused])
  return (
    <td className="px-1 py-1">
      <textarea
        aria-label={label}
        rows={2}
        className={`${cell} field-sizing-content min-h-9`}
        value={focused ? draft : value}
        onFocus={() => {
          setDraft(value)
          setFocused(true)
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setFocused(false)
          if (draft !== value) onChange(draft)
        }}
      />
      {children}
    </td>
  )
}
