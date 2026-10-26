import type { Engine } from '@plein/canvas-core'
import type { Shot } from '@plein/nodes'
import { useRef, useState } from 'react'
import {
  addAdaptationProposal,
  addSourceUnit,
  captureSourceSnapshot,
  listSourceInputs,
  markSourceRead,
  readSourceSlice,
  removeSourceLink,
  removeSourceUnit,
  setSourceLink,
  setUnitDisposition,
  sourceLinkState,
  sourceMapOf,
  sourceSnapshotState,
  type SourceLink,
  type SourceUnit,
} from '@plein/doc'
import { useDocVersion } from '../../canvas/hooks'
import { useCanvas } from '../../stores/canvas'
import { useSession } from '../../stores/session'
import {
  sourceDisplayOffset,
  sourceExcerpt,
  sourceRawOffset,
  sourceSelectionAfterKey,
  sourceUnitStatus,
} from './sourceMapping'

const field = 'ui-input w-full'
const button = 'ui-btn ui-btn-secondary'
const treatments = { retain: '保留', compress: '压缩', merge: '合并' } as const
const states = {
  current: '当前来源与固定版一致',
  changed: '来源已修改：当前仍查看固定旧版，请复核后固定新版本',
  missing: '来源已删除：保留历史原文',
  external: '外部来源：仅保留历史，当前文档未绑定',
  disconnected: '来源连线已移除：保留历史原文',
}

export function SourceMappingPanel({
  engine,
  boardId,
  shots,
  onLocateShot,
  onLocateSource,
}: {
  engine: Engine
  boardId: string
  shots: Shot[]
  onLocateShot(shotId: string): void
  onLocateSource(elementId: string): void
}) {
  useDocVersion(engine.doc)
  const canvasId = useCanvas((s) => s.canvasId)
  const principal = useSession((s) => s.info?.principal)
  const [inputKey, setInputKey] = useState('')
  const [snapshotId, setSnapshotId] = useState('')
  const [offset, setOffset] = useState(0)
  const [range, setRange] = useState<{ snapshotId: string; start: number; end: number } | null>(
    null,
  )
  const [kind, setKind] = useState<SourceUnit['kind']>('event')
  const [shotId, setShotId] = useState('')
  const [treatment, setTreatment] = useState<SourceLink['treatment']>('retain')
  const [proposal, setProposal] = useState('')
  const [error, setError] = useState('')
  const text = useRef<HTMLTextAreaElement>(null)
  const record = sourceMapOf(engine.doc, boardId)
  const inputs = listSourceInputs(engine.doc, boardId)
  const key = (v: { elementId: string; port: string }) => JSON.stringify([v.elementId, v.port])
  const input = inputs.find((v) => key(v) === inputKey) ?? inputs[0]
  const snapshot =
    record.snapshots.find((s) => s.id === snapshotId) ??
    record.snapshots
      .filter((snapshot) => record.sources.some((entry) => entry.activeSnapshotId === snapshot.id))
      .sort((a, b) => a.capturedAt - b.capturedAt || a.id.localeCompare(b.id))
      .at(-1)
  const page = snapshot && readSourceSlice(snapshot, offset)
  const units = record.units
    .filter((u) => u.snapshotId === snapshot?.id)
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const readonly = engine.doc.readOnly || !principal || principal.role === 'viewer'
  const write = (action: () => unknown) => {
    const state = useCanvas.getState()
    const currentPrincipal = useSession.getState().info?.principal
    if (
      engine.doc.readOnly ||
      !currentPrincipal ||
      currentPrincipal.role === 'viewer' ||
      state.engine !== engine ||
      state.canvasId !== canvasId ||
      state.storyboard !== boardId ||
      !engine.doc.get(boardId)
    ) {
      setError('画布或可写状态已变化，本次修改未执行')
      return
    }
    const result = action()
    setError(
      result === undefined || result === false ? '来源、范围或镜头已变化，请重新选择后再保存' : '',
    )
  }
  const captureSelection = (target: HTMLTextAreaElement) => {
    if (!page) return
    // 选区固定在用户所见的版本，不随协作者推进 active 转移。
    setSnapshotId(page.snapshotId)
    setRange({
      snapshotId: page.snapshotId,
      start: page.offset + sourceRawOffset(page.text, target.selectionStart),
      end: page.offset + sourceRawOffset(page.text, target.selectionEnd),
    })
  }
  const locate = (unit: SourceUnit) => {
    setSnapshotId(unit.snapshotId)
    setOffset(unit.start)
    setRange({ snapshotId: unit.snapshotId, start: unit.start, end: unit.end })
    requestAnimationFrame(() => {
      const source = record.snapshots.find((snapshot) => snapshot.id === unit.snapshotId)
      const view = source && readSourceSlice(source, unit.start)
      text.current?.focus()
      text.current?.setSelectionRange(
        0,
        view
          ? sourceDisplayOffset(view.text, Math.min(unit.end - unit.start, view.text.length))
          : 0,
      )
    })
  }
  return (
    <section
      aria-label="剧情来源与镜头覆盖"
      className="min-h-0 flex-1 overflow-y-auto p-5"
      data-testid="source-mapping"
    >
      <p className="mb-4 text-sm text-ink-subtle">
        固定完整原文后，人工划定事件或对白并关联镜头。映射仅说明人工标注的覆盖，不代表叙事完整性；此处操作不会运行模型。
      </p>
      {error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="min-w-0 space-y-3">
          <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1 text-sm">
              当前剧本输入
              <select
                aria-label="当前剧本输入"
                className={field}
                value={input ? key(input) : ''}
                onChange={(e) => setInputKey(e.target.value)}
              >
                {!inputs.length && <option value="">尚未连接剧本文本</option>}
                {inputs.map((v, index) => (
                  <option key={key(v)} value={key(v)}>
                    {index + 1}. {v.name} · {v.port}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={button}
              disabled={readonly || !canvasId || input?.text === undefined || !input.text.trim()}
              onClick={() =>
                write(() => {
                  if (!input || !canvasId) return false
                  const id = captureSourceSnapshot(engine.doc, boardId, {
                    canvasId,
                    elementId: input.elementId,
                    port: input.port,
                    expectedText: input.text!,
                    expectedResultId: input.resultId,
                  })
                  if (id) {
                    setSnapshotId(id)
                    setOffset(0)
                    setRange(null)
                  }
                  return id
                })
              }
            >
              固定为新版本
            </button>
          </div>
          {input?.problem && <p className="text-sm text-ink-subtle">{input.problem}</p>}
          <label className="block text-sm">
            固定原文版本
            <select
              aria-label="固定原文版本"
              className={field}
              value={snapshot?.id ?? ''}
              onChange={(e) => {
                setSnapshotId(e.target.value)
                setOffset(0)
                setRange(null)
              }}
            >
              {!record.snapshots.length && <option value="">尚未固定原文</option>}
              {record.snapshots.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {new Date(s.capturedAt).toLocaleString()} · {s.id.slice(-6)}
                  {record.sources.some((entry) => entry.activeSnapshotId === s.id)
                    ? ' · 当前计划版本'
                    : ' · 历史版本'}
                </option>
              ))}
            </select>
          </label>
          {snapshot && page && (
            <>
              <p role="status" className="text-sm text-ink-subtle">
                {states[sourceSnapshotState(engine.doc, boardId, snapshot)]}
              </p>
              <p className="text-xs text-ink-subtle">
                原始出处：{snapshot.originAtCapture.elementId} / {snapshot.originAtCapture.port}
                {snapshot.originAtCapture.resultId ? ` / ${snapshot.originAtCapture.resultId}` : ''}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm">
                  {record.readSnapshotIds.includes(snapshot.id)
                    ? '已显式核对本版原文'
                    : '未读：尚未声明核对本版原文'}
                </span>
                <button
                  type="button"
                  className={button}
                  disabled={readonly || record.readSnapshotIds.includes(snapshot.id)}
                  onClick={() => write(() => markSourceRead(engine.doc, boardId, snapshot.id))}
                >
                  我已核对本版原文
                </button>
                {record.sources.find((s) => s.id === snapshot.sourceId)?.binding && (
                  <button
                    type="button"
                    className={button}
                    onClick={() => {
                      const binding = record.sources.find(
                        (s) => s.id === snapshot.sourceId,
                      )?.binding
                      if (binding && engine.doc.get(binding.elementId))
                        onLocateSource(binding.elementId)
                      else setError('当前来源已删除，仍可查看固定原文')
                    }}
                  >
                    定位来源节点
                  </button>
                )}
              </div>
              <textarea
                data-source-original=""
                ref={text}
                readOnly
                aria-label="固定原文"
                className={`${field} min-h-64 resize-y whitespace-pre-wrap font-mono`}
                value={page.text.replace(/\r\n?/g, '\n')}
                onSelect={(e) => captureSelection(e.currentTarget)}
                onKeyUp={(e) => captureSelection(e.currentTarget)}
                onPointerUp={(e) => captureSelection(e.currentTarget)}
                onBlur={(e) => captureSelection(e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) return
                  const target = e.currentTarget
                  const selection = sourceSelectionAfterKey({
                    text: target.value,
                    start: target.selectionStart,
                    end: target.selectionEnd,
                    direction: target.selectionDirection,
                    key: e.key,
                    shift: e.shiftKey,
                  })
                  if (!selection) return
                  e.preventDefault()
                  e.stopPropagation()
                  target.setSelectionRange(selection.start, selection.end, selection.direction)
                  captureSelection(target)
                }}
              />
              <div className="flex items-center gap-2 text-xs text-ink-subtle">
                <button
                  type="button"
                  className={button}
                  disabled={page.offset === 0}
                  onClick={() => {
                    setOffset(Math.max(0, page.offset - 8000))
                    setRange(null)
                  }}
                >
                  上一段
                </button>
                <span>
                  {page.offset}–{page.end} / {page.total} 字符，全文已保留
                </span>
                <button
                  type="button"
                  className={button}
                  disabled={page.end >= page.total}
                  onClick={() => {
                    setOffset(page.end)
                    setRange(null)
                  }}
                >
                  下一段
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="原文标注类型"
                  className="ui-input"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as SourceUnit['kind'])}
                >
                  <option value="event">事件</option>
                  <option value="dialogue">对白</option>
                </select>
                <button
                  type="button"
                  className={button}
                  disabled={
                    readonly ||
                    !range ||
                    range.snapshotId !== snapshot.id ||
                    range.end <= range.start
                  }
                  onClick={() =>
                    write(
                      () =>
                        range &&
                        range.snapshotId === snapshot.id &&
                        addSourceUnit(engine.doc, boardId, {
                          ...range,
                          kind,
                        }),
                    )
                  }
                >
                  将选中原文加入标注
                </button>
                <span className="text-xs text-ink-subtle">
                  {range && range.end > range.start
                    ? `范围 ${range.start}–${range.end}`
                    : '在原文中选取准确范围'}
                </span>
              </div>
            </>
          )}
        </div>
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1 text-sm">
              关联或定位镜头
              <select
                aria-label="关联或定位镜头"
                className={field}
                value={shotId}
                onChange={(e) => setShotId(e.target.value)}
              >
                <option value="">请选择镜头</option>
                {shots.map((s) => (
                  <option key={s.id} value={s.id}>
                    镜头 {s.no} · {s.description.slice(0, 40)}
                  </option>
                ))}
              </select>
            </label>
            <select
              aria-label="覆盖处理"
              className="ui-input"
              value={treatment}
              onChange={(e) => setTreatment(e.target.value as SourceLink['treatment'])}
            >
              {Object.entries(treatments).map(([value, title]) => (
                <option key={value} value={value}>
                  {title}
                </option>
              ))}
            </select>
          </div>
          {shotId && (
            <div
              className="rounded-lg border border-line p-3 text-sm"
              role="region"
              aria-label="镜头对应原文"
            >
              <p>镜头对应原文</p>
              {record.links.filter((l) => l.shotId === shotId).length ? (
                record.links
                  .filter((l) => l.shotId === shotId)
                  .map((link) => {
                    const unit = record.units.find((u) => u.id === link.unitId)
                    const source = record.snapshots.find((s) => s.id === unit?.snapshotId)
                    return (
                      unit &&
                      source && (
                        <button
                          type="button"
                          key={link.id}
                          className={`${button} mt-2 w-full justify-start text-left`}
                          onClick={() => locate(unit)}
                        >
                          {source.name}
                          {record.sources.some((entry) => entry.activeSnapshotId === source.id)
                            ? ''
                            : '（历史版本）'}
                          ：{sourceExcerpt(source.text, unit.start, unit.end, 80)}
                        </button>
                      )
                    )
                  })
              ) : (
                <p className="text-ink-subtle">尚未映射原文</p>
              )}
            </div>
          )}
          <p className="text-sm text-ink-subtle">
            本版 {units.length} 个人工标注；未标注的原文仍需人工检查。
          </p>
          <ul aria-label="原文标注" className="space-y-3">
            {units.map((unit) => (
              <li
                key={unit.id}
                data-unit-id={unit.id}
                className="rounded-lg border border-line p-3 text-sm"
              >
                <div className="flex items-center gap-2">
                  <span>
                    {unit.kind === 'dialogue' ? '对白' : '事件'} ·{' '}
                    {sourceUnitStatus(engine.doc, boardId, record, unit)}
                  </span>
                  <button
                    type="button"
                    className={`${button} ml-auto`}
                    onClick={() => locate(unit)}
                  >
                    定位原文
                  </button>
                </div>
                <p className="my-2 whitespace-pre-wrap">
                  {sourceExcerpt(snapshot!.text, unit.start, unit.end)}
                </p>
                <ul className="space-y-2">
                  {record.links
                    .filter((l) => l.unitId === unit.id)
                    .map((link) => (
                      <li key={link.id} className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className={button}
                          disabled={!shots.some((s) => s.id === link.shotId)}
                          onClick={() => onLocateShot(link.shotId)}
                        >
                          定位镜头 {shots.find((s) => s.id === link.shotId)?.no ?? '（已删除）'}
                        </button>
                        <span>
                          {treatments[link.treatment]}
                          {sourceLinkState(engine.doc, boardId, link) === 'changed'
                            ? ' · 内容已变，待复核'
                            : sourceLinkState(engine.doc, boardId, link) === 'missing'
                              ? ' · 镜头已删除'
                              : ''}
                        </span>
                        <button
                          type="button"
                          className={button}
                          disabled={readonly}
                          onClick={() =>
                            write(() => removeSourceLink(engine.doc, boardId, link.id))
                          }
                        >
                          移除关联
                        </button>
                      </li>
                    ))}
                </ul>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={button}
                    disabled={readonly || !shotId || unit.disposition === 'out_of_scope'}
                    onClick={() =>
                      write(() =>
                        setSourceLink(engine.doc, boardId, { unitId: unit.id, shotId, treatment }),
                      )
                    }
                  >
                    关联所选镜头
                  </button>
                  <button
                    type="button"
                    className={button}
                    disabled={readonly}
                    onClick={() =>
                      write(() =>
                        setUnitDisposition(
                          engine.doc,
                          boardId,
                          unit.id,
                          unit.disposition === 'out_of_scope' ? 'in_scope' : 'out_of_scope',
                        ),
                      )
                    }
                  >
                    {unit.disposition === 'out_of_scope' ? '纳入范围' : '标为范围外'}
                  </button>
                  <button
                    type="button"
                    className={button}
                    disabled={readonly}
                    onClick={() => write(() => removeSourceUnit(engine.doc, boardId, unit.id))}
                  >
                    删除标注
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="space-y-2 rounded-lg border border-line p-3">
            <label className="block text-sm">
              新增改编提案
              <textarea
                aria-label="新增改编提案"
                className={field}
                value={proposal}
                disabled={readonly}
                onChange={(e) => setProposal(e.target.value)}
                placeholder="可没有原文依据；仅记录提案，等待人工判断"
              />
            </label>
            <button
              type="button"
              className={button}
              disabled={readonly || !proposal.trim()}
              onClick={() =>
                write(() => {
                  const id = addAdaptationProposal(
                    engine.doc,
                    boardId,
                    shotId ? [shotId] : [],
                    proposal,
                  )
                  if (id) setProposal('')
                  return id
                })
              }
            >
              保存改编提案
            </button>
            <ul aria-label="改编提案">
              {record.proposals.map((p) => (
                <li key={p.id} className="mt-2 text-sm">
                  提案（非原文）：{p.note}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}
