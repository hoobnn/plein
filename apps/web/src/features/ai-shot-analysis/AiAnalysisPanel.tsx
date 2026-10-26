import type { Engine } from '@plein/canvas-core'
import {
  AiSceneRequest,
  AiSummaryRequest,
  AiSummaryResult,
  AI_SCENE_TYPE,
  isAiAnalysisType,
  type AiDraftReference,
} from '@plein/nodes'
import type { PreparedInput, JobInfo } from '@plein/protocol'
import { useEffect, useRef, useState } from 'react'
import { api, assetUrls } from '../../api/client'
import { useDocVersion } from '../../canvas/hooks'
import { formatTimecode } from '../../canvas/media'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { useSession } from '../../stores/session'
import { Modal, ModalHeader } from '../../ui/Modal'
import { analysisManifest } from '../shot-analysis/model'
import type { AiAnalysisTarget } from './AiAnalysisEditor'
import {
  aiModels,
  createScenePlan,
  createSummaryPlan,
  convertAiDrafts,
  draftReference,
  sameReportOrigin,
} from './model'

const wait = () => new Promise((resolve) => setTimeout(resolve, 250))
type Preview = { id: string; input: PreparedInput; snapshot: string }
export function AiAnalysisPanel({
  engine,
  target,
  onClose,
}: {
  engine: Engine
  target: AiAnalysisTarget
  onClose(): void
}) {
  useDocVersion(engine.doc)
  const canvasId = useCanvas((state) => state.canvasId)
  const principal = useSession((state) => state.info?.principal)
  const catalog = useCatalog((state) => state.catalog)
  const [model, setModel] = useState('')
  const [summaryModel, setSummaryModel] = useState('')
  const [focus, setFocus] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [plan, setPlan] = useState<string[]>(target.kind === 'node' ? [target.nodeId] : [])
  const [previews, setPreviews] = useState<Preview[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState<{ nodeId: string; runId: string }>()
  const alive = useRef(true)
  const stop = useRef(false)
  const epoch = useRef(0)
  const busyRef = useRef(false)
  const targetKey = JSON.stringify(target)
  const readonly =
    engine.doc.readOnly ||
    !canvasId ||
    !principal ||
    principal.role === 'viewer' ||
    (target.kind === 'node' && !!engine.doc.get(target.nodeId)?.locked)
  const current = () =>
    alive.current &&
    useCanvas.getState().engine === engine &&
    useCanvas.getState().canvasId === canvasId &&
    JSON.stringify(useCanvas.getState().aiAnalysis) === targetKey
  const writable = () =>
    current() &&
    !engine.doc.readOnly &&
    !(target.kind === 'node' && engine.doc.get(target.nodeId)?.locked) &&
    useSession.getState().info?.principal?.role !== 'viewer' &&
    !!useSession.getState().info?.principal
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      stop.current = true
    }
  }, [])
  const local =
    target.kind === 'local'
      ? analysisManifest(engine.doc, target.nodeId, target.resultId)
      : undefined
  const selectedNode = target.kind === 'node' ? engine.doc.get(target.nodeId) : undefined
  const sceneRequest = AiSceneRequest.safeParse(selectedNode?.params?.request)
  const summaryRequest = AiSummaryRequest.safeParse(selectedNode?.params?.request)
  const base = local
    ? {
        origin: { canvasId: canvasId ?? '', nodeId: target.nodeId, resultId: local.result.id },
        scenes: local.manifest.scenes,
        total: local.manifest.scenes.length,
      }
    : sceneRequest.success
      ? {
          origin: sceneRequest.data.scope.origin,
          scenes: [sceneRequest.data.scope.scene],
          total: sceneRequest.data.scope.totalScenes,
        }
      : summaryRequest.success
        ? {
            origin: summaryRequest.data.drafts[0]!.value.request.scope.origin,
            scenes: summaryRequest.data.drafts.map((d) => d.value.request.scope.scene),
            total: summaryRequest.data.drafts[0]!.value.request.scope.totalScenes,
          }
        : undefined
  const refs: AiDraftReference[] = []
  if (base && canvasId)
    for (const node of engine.doc.elements()) {
      if (node.nodeType !== AI_SCENE_TYPE) continue
      for (const result of node.results ?? []) {
        const ref = draftReference(engine.doc, canvasId, node.id, result.id)
        if (ref && sameReportOrigin(ref.value.request.scope.origin, base.origin)) refs.push(ref)
      }
    }
  const chosen = refs.filter((ref) => selected.has(`${ref.origin.nodeId}/${ref.origin.resultId}`))
  const invalidate = () => {
    epoch.current++
    setPlan([])
    setPreviews([])
  }
  const action = async (work: () => Promise<void> | void) => {
    if (!writable() || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setMessage('')
    try {
      await work()
    } catch (error) {
      if (current()) setMessage((error as Error).message)
    } finally {
      busyRef.current = false
      if (current()) setBusy(false)
    }
  }
  const makePlan = () =>
    action(async () => {
      if (!catalog || !canvasId || !local || target.kind !== 'local')
        throw new Error('本地清单不可用')
      const ids = await createScenePlan(
        engine.doc,
        catalog,
        canvasId,
        target.nodeId,
        target.resultId,
        [...picked],
        model,
        focus,
        writable,
      )
      if (!current()) return
      setPlan(ids)
      setPreviews([])
      setMessage('已建立空分析作业，尚未调用模型。请预检后明确运行。')
    })
  const preview = () =>
    action(async () => {
      if (!canvasId || !plan.length) return
      const version = epoch.current
      const result: Preview[] = []
      for (const id of plan) {
        const snapshot = JSON.stringify(engine.doc.get(id)?.params)
        let input: PreparedInput | undefined
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            const next = await api.nodeInput(canvasId, id)
            if (JSON.stringify(next.params) === snapshot) {
              input = next
              break
            }
          } catch (error) {
            if (attempt === 3) throw error
          }
          await wait()
        }
        if (
          !input ||
          !current() ||
          epoch.current !== version ||
          JSON.stringify(engine.doc.get(id)?.params) !== snapshot
        )
          throw new Error('实际输入或查看对象已变化，请重新预检')
        result.push({ id, input, snapshot })
      }
      setPreviews(result)
    })
  const run = () =>
    action(async () => {
      if (
        !canvasId ||
        !previews.length ||
        previews.some((row) => row.input.status !== 'ready' || !row.input.inputHash)
      )
        return
      stop.current = false
      const approved = previews
      const remaining = new Set(approved.map((row) => row.id))
      try {
        for (const row of approved) {
          if (!writable() || stop.current) break
          if (JSON.stringify(engine.doc.get(row.id)?.params) !== row.snapshot)
            throw new Error('固定请求已修改，剩余作业未提交，请重新预检')
          const started = await api.runNode(canvasId, row.id, { expect: row.input.inputHash })
          remaining.delete(row.id)
          if (!current()) break
          setActive({ nodeId: row.id, runId: started.runId })
          let job: JobInfo | undefined
          while (current()) {
            const latest = (await api.canvasNodeJobs(canvasId, [row.id])).jobs[0]
            if (latest && latest.id !== started.runId)
              throw new Error('作业已变化，停止提交剩余计划')
            job = latest
            if (job && !['queued', 'running'].includes(job.status)) break
            await wait()
          }
          if (!current()) break
          if (job) {
            const submitted =
              job.submissionHistory?.filter((item) => item.kind === 'submit_started').length ?? 0
            setMessage(
              `当前作业 ${job.status}；journal 记录 ${submitted} 次提交尝试、运行尝试 ${job.attempts} 次。恢复提交另计，结果不代表声音或完整运动已核实。`,
            )
            const unsettled =
              ['submit_unknown', 'remote_pending', 'fetch_failed'].includes(
                job.recovery?.state ?? '',
              ) && !job.recovery?.dismissed
            if (job.status === 'failed' && !unsettled) remaining.add(row.id)
            if (unsettled) {
              stop.current = true
              setMessage(
                '原作业需要核查或取回；剩余作业未提交。请在任务面板处理，不能用新作业绕过。',
              )
            }
          }
          setActive(undefined)
        }
      } finally {
        if (current()) {
          setPlan([...remaining])
          setPreviews([])
        }
      }
    })
  const summaries =
    selectedNode?.nodeType && isAiAnalysisType(selectedNode.nodeType)
      ? (selectedNode.results ?? [])
      : [...engine.doc.elements()]
          .filter((node) => node.nodeType === 'plein/shot-summary-draft')
          .flatMap((node) => node.results ?? [])
  return (
    <Modal label="AI 拉片草稿" onClose={onClose} isolateKeys className="max-w-6xl">
      <ModalHeader title="AI 拉片草稿" meta="默认关闭 · 逐镜与归纳独立保存" onClose={onClose} />
      <div className="min-h-0 space-y-5 overflow-y-auto p-5">
        <p className="ui-help">
          每份最多 3 镜、每镜仅送 P08 已有 1
          张关键帧；不读取音轨或完整视频。模型文字是未人工核实的草稿。初始最多 4
          个计划调用单元，失败单元最多再建 1 个重试作业；实际恢复提交沿原 journal 单列，不能把 8
          个新作业当作提交次数上限。
        </p>
        {readonly && (
          <p role="status" className="ui-help">
            当前只读：可查看数据，不能建立计划、运行或转换草稿。
          </p>
        )}
        {message && (
          <p role="status" className="text-sm text-ink-muted">
            {message}
          </p>
        )}
        {!base ? (
          <p>请求或本地清单不可用。请从本地拉片清单创建新分析版本。</p>
        ) : (
          <>
            <p className="ui-help">
              来源候选 {base.origin.resultId} · 本地共 {base.total}{' '}
              镜。范围以首视频帧为零，实际帧持续时间与采样请求分开保存。
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              {base.scenes.map((scene) => (
                <label
                  key={scene.id}
                  className="space-y-2 rounded-lg border border-line p-3 text-sm"
                >
                  {target.kind === 'local' && (
                    <input
                      type="checkbox"
                      disabled={readonly || busy}
                      checked={picked.has(scene.id)}
                      onChange={(event) => {
                        invalidate()
                        setPicked((previous) => {
                          const next = new Set(previous)
                          if (event.target.checked) next.add(scene.id)
                          else next.delete(scene.id)
                          return next
                        })
                      }}
                    />
                  )}
                  <span>
                    {' '}
                    {scene.id} · {formatTimecode(scene.start)} — {formatTimecode(scene.end)}
                  </span>
                  <img
                    loading="lazy"
                    className="aspect-video w-full object-contain"
                    src={assetUrls.original(scene.frame.assetId)}
                    alt={`${scene.id} 实际送入的采样帧`}
                  />
                  <span className="block text-xs text-ink-muted">
                    请求 {scene.frame.at.toFixed(3)} 秒；实际{' '}
                    {scene.frame.actualAt?.toFixed(3) ?? '未知'} 秒
                  </span>
                </label>
              ))}
            </div>
            {target.kind === 'local' && (
              <div className="space-y-3">
                <label className="block text-sm">
                  逐镜视觉模型
                  <select
                    className="ui-input ml-2"
                    aria-label="逐镜视觉模型"
                    value={model}
                    disabled={readonly || busy}
                    onChange={(event) => {
                      invalidate()
                      setModel(event.target.value)
                    }}
                  >
                    <option value="">请明确选择模型</option>
                    {aiModels(catalog, true).map((item) => (
                      <option key={item.ref} value={item.ref}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  分析重点
                  <textarea
                    className="ui-input mt-2 w-full"
                    maxLength={1000}
                    disabled={readonly || busy}
                    value={focus}
                    onChange={(event) => {
                      invalidate()
                      setFocus(event.target.value)
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary"
                  disabled={readonly || busy || !model || !picked.size || picked.size > 3}
                  onClick={() => void makePlan()}
                >
                  建立所选逐镜计划（零调用）
                </button>
              </div>
            )}
          </>
        )}
        {(plan.length > 0 || active) && (
          <section
            aria-label="待确认分析计划"
            className="space-y-3 rounded-xl border border-line p-4"
          >
            <p>
              本计划 {plan.length} 个作业／计划调用单元；作业自动重新执行
              0。模型调用沿宿主当前超时设置（默认 30 分钟）。
            </p>
            <button
              type="button"
              className="ui-btn ui-btn-secondary"
              disabled={readonly || busy}
              onClick={() => void preview()}
            >
              预检实际输入与费用
            </button>
            {previews.map((row) => {
              const params = row.input.params
              const price = aiModels(catalog, false).find(
                (model) => model.ref === params.model,
              )?.price
              return (
                <div key={row.id} className="space-y-2 rounded-lg bg-surface-2 p-3 text-sm">
                  <p>
                    {row.input.model?.title ?? '未选模型'} ·{' '}
                    {price ? `配置估算 ${price.amount} ${price.currency}` : '价格未知'} ·{' '}
                    {row.input.status}
                  </p>
                  <p>输入/输出 token、图片费用与恢复提交费用未知。</p>
                  <details>
                    <summary>完整固定请求、具体采样与重点</summary>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs">
                      {JSON.stringify(params, null, 2)}
                    </pre>
                  </details>
                  {row.input.blocked.map((issue) => (
                    <p key={JSON.stringify(issue)} className="text-danger">
                      {issue.message}
                    </p>
                  ))}
                </div>
              )
            })}
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              disabled={
                readonly ||
                busy ||
                previews.length !== plan.length ||
                previews.some((row) => row.input.status !== 'ready')
              }
              onClick={() => void run()}
            >
              确认运行本计划（可能计费）
            </button>
            {active && (
              <button
                type="button"
                className="ui-btn ui-btn-secondary"
                disabled={readonly}
                onClick={() => {
                  stop.current = true
                  if (canvasId)
                    void api.cancelNode(canvasId, active.nodeId, { runId: active.runId })
                }}
              >
                取消当前并停止后续提交
              </button>
            )}
          </section>
        )}
        <section className="space-y-3" aria-label="逐镜模型草稿">
          <h3 className="text-sm font-medium">逐镜历史草稿 · 显式选择最多 3 个不同镜头</h3>
          {refs.map((ref) => {
            const key = `${ref.origin.nodeId}/${ref.origin.resultId}`
            return (
              <div key={key} className="rounded-lg border border-line p-3 text-sm">
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(key)}
                    onChange={(event) =>
                      setSelected((previous) => {
                        const next = new Set(previous)
                        if (event.target.checked) next.add(key)
                        else next.delete(key)
                        return next
                      })
                    }
                  />{' '}
                  {ref.value.request.scope.scene.id} · {ref.value.request.modelRef} ·{' '}
                  {ref.value.model.declaredVersion ?? '模型权重版本未声明'} · {ref.origin.resultId}
                </label>
                <p className="mt-2 whitespace-pre-wrap">模型草稿：{ref.value.draft.description}</p>
                <details>
                  <summary>描述／推测／未知及出处</summary>
                  <pre className="whitespace-pre-wrap break-all text-xs">
                    {JSON.stringify(ref.value, null, 2)}
                  </pre>
                </details>
              </div>
            )
          })}
          <label className="block text-sm">
            独立归纳模型
            <select
              className="ui-input ml-2"
              aria-label="独立归纳模型"
              value={summaryModel}
              disabled={readonly || busy}
              onChange={(event) => setSummaryModel(event.target.value)}
            >
              <option value="">请明确选择模型</option>
              {aiModels(catalog, false).map((item) => (
                <option key={item.ref} value={item.ref}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <p className="ui-help">
            归纳仅读取所选 {chosen.length}{' '}
            份文字草稿；没有选择的镜头与整片声音/运动均未知。请另建归纳计划并独立确认。
          </p>
          <button
            type="button"
            className="ui-btn ui-btn-secondary"
            disabled={readonly || busy || !chosen.length || chosen.length > 3 || !summaryModel}
            onClick={() =>
              void action(() => {
                if (!catalog || !canvasId) return
                const id = createSummaryPlan(
                  engine.doc,
                  catalog,
                  canvasId,
                  chosen,
                  summaryModel,
                  focus,
                )
                setPlan([id])
                setPreviews([])
              })
            }
          >
            建立独立归纳计划（零调用）
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-secondary ml-2"
            disabled={readonly || busy || !chosen.length || chosen.length > 3}
            onClick={() =>
              void action(() => {
                if (!canvasId) return
                const made = convertAiDrafts(engine.doc, canvasId, chosen)
                engine.selection.set([made.board])
                setMessage(
                  '已新建独立模型分镜草稿与 P05 出处；每镜计划时长默认 5 秒，可编辑。未采用素材、未展开、未生成。',
                )
              })
            }
          >
            转为独立可编辑分镜草稿
          </button>
        </section>
        <section aria-label="独立归纳结果" className="space-y-2">
          {summaries.map((result) => {
            const parsed = AiSummaryResult.safeParse(
              result.value.type === 'json' ? result.value.value : undefined,
            )
            if (
              !parsed.success ||
              (base &&
                !sameReportOrigin(
                  parsed.data.request.drafts[0]!.value.request.scope.origin,
                  base.origin,
                ))
            )
              return null
            return (
              <div key={result.id} className="rounded-lg border border-line p-3">
                <p className="text-sm">采样归纳草稿 · 非完整影片审片</p>
                <pre className="whitespace-pre-wrap break-all text-sm">
                  {JSON.stringify(parsed.data.draft, null, 2)}
                </pre>
              </div>
            )
          })}
        </section>
      </div>
    </Modal>
  )
}
