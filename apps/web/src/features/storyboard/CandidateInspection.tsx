import type { Engine } from '@plein/canvas-core'
import { adoptResult, currentResult, type CanvasElement, type NodeResult } from '@plein/doc'
import type { ShotRole } from '@plein/nodes'
import type { PreparedInput } from '@plein/protocol'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api, assetUrls } from '../../api/client'
import { useDocVersion } from '../../canvas/hooks'
import { upstreams } from '../../canvas/nodes'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { Icon } from '../../ui/icons'
import { Select } from '../../ui/Select'
import { describeRecovery } from '../runs/recovery'
import { CreativeReviewForm, reviewLabels } from './CreativeReviewForm'
import { shotsOf, type ShotSource } from './model'
import { reviewNodesForShot } from './reviewModel'
import { roles } from './shotWorkbench.utils'

let nextInspectionRead = 0

export function CandidateInspection({
  engine,
  boardId,
  shotId,
  canvasId,
  node,
  active,
  writable,
  stale,
  onLocate,
  generationRole,
  selected,
  onSelect,
  sharedInput,
  onGenerate,
}: {
  engine: Engine
  boardId: string
  shotId: string
  canvasId: string
  node: CanvasElement
  active(): boolean
  writable(): boolean
  stale: boolean
  onLocate(): void
  generationRole?: 'image' | 'video'
  /** 当前查看的候选 id（受控于工作台，切历史候选时对照区同步回退主按钮） */
  selected: string
  onSelect(candidateId: string): void
  /** 摘要已取过的同一节点输入，避免重复请求；查看其他节点时为空 */
  sharedInput?: UseQueryResult<PreparedInput>
  onGenerate(role: ShotRole): void
}) {
  const reviewContainer = useRef<HTMLDivElement>(null)
  const version = useDocVersion(engine.doc),
    catalog = useCatalog((s) => s.catalog)
  const [element] = useState(() => engine.doc.elementMaps.get(node.id))
  const identity = (n: CanvasElement) => {
    const source = n.params?.source as ShotSource | undefined
    return JSON.stringify([
      source?.storyboard,
      source?.shot,
      source?.role,
      source?.dialogueId,
      source?.line,
      source?.detached,
    ])
  }
  const [sourceIdentity] = useState(() => identity(node))
  const [readEpoch] = useState(() => ++nextInspectionRead)
  const [error, setError] = useState('')
  const adoptedResult = currentResult(node)
  const candidate = selected
    ? node.results?.find((r) => r.id === selected)
    : (adoptedResult ?? node.results?.[0])
  const binding = JSON.stringify([node.id, candidate?.id, candidate?.runId, candidate?.value])
  const validNode = () => {
    const now = engine.doc.get(node.id),
      source = now?.params?.source as ShotSource | undefined
    const shot = shotsOf(engine.doc.get(boardId)).find((s) => s.id === shotId)
    return (
      active() &&
      engine.doc.elementMaps.get(node.id) === element &&
      !!now &&
      source?.storyboard === boardId &&
      source.shot === shotId &&
      identity(now) === sourceIdentity &&
      !!shot &&
      reviewNodesForShot(shot, [now]).length === 1
    )
  }
  const old = useQuery({
    queryKey: ['workbench-job', canvasId, binding],
    enabled: !!candidate?.runId && validNode(),
    retry: false,
    queryFn: async () => {
      const job = await api.canvasJob(canvasId, candidate!.runId)
      if (
        !validNode() ||
        job.nodeId !== node.id ||
        job.id !== candidate!.runId ||
        job.input?.nodeId !== node.id
      )
        throw new Error('没有与此候选匹配的生成依据')
      return job
    },
  })
  // 摘要已取过同一节点的输入时直接复用，不再重复请求
  const ownInput = useQuery({
    queryKey: ['workbench-input', canvasId, boardId, shotId, node.id, readEpoch, version],
    enabled: validNode() && !sharedInput,
    retry: false,
    gcTime: 0,
    queryFn: async () => {
      const input = await api.nodeInput(canvasId, node.id)
      if (!validNode() || input.nodeId !== node.id) throw new Error('阶段身份已变化')
      return input
    },
  })
  const current = sharedInput ?? ownInput
  const jobs = useQuery({
    queryKey: ['workbench-latest', canvasId, node.id, readEpoch],
    enabled: validNode(),
    queryFn: async () => {
      const result = await api.canvasNodeJobs(canvasId, [node.id])
      if (!validNode()) throw new Error('阶段身份已变化')
      return result
    },
    refetchInterval: 1500,
  })
  const latest = jobs.data?.jobs.find((j) => j.nodeId === node.id),
    recovery = latest && describeRecovery(latest)
  const refs = [...upstreams(engine, node.id, catalog).values()].flat()
  const adopted = candidate && currentResult(node, candidate.port)?.id === candidate.id
  const historyReview =
    candidate &&
    node.reviews?.find(
      (review) =>
        review.target.resultId === candidate.id &&
        'assetId' in candidate.value &&
        review.target.assetId === candidate.value.assetId &&
        review.target.kind === candidate.value.type,
    )
  return (
    <>
      {!validNode() && <p role="alert">阶段身份已变化，请重新选择阶段或打开工作台。</p>}
      {(stale || latest) && (
        <p className="text-xs">
          {stale ? '输入已变化，采用的旧候选需重新核对。' : ''}
          {latest && `任务 ${latest.status} · 尝试 ${latest.attempts}`}
        </p>
      )}
      <div className="block text-sm">
        查看候选{' '}
        <Select
          aria-label="工作台候选"
          className="ui-input w-full"
          value={candidate?.id ?? selected}
          options={[
            { value: '', label: adoptedResult ? '当前采用候选' : '尚未采用' },
            ...(node.results ?? []).map((r) => ({
              value: r.id,
              label: `${adoptedResult ? (currentResult(node, r.port)?.id === r.id ? '已采用' : '历史') : '待采用'} · ${r.id.slice(-10)} · ${r.port}`,
            })),
          ]}
          onChange={onSelect}
        />
      </div>
      {candidate ? (
        <CandidateMedia key={binding} result={candidate} />
      ) : (
        <div className="plein-shot-preview-empty">
          <Icon name="video" size={24} />
          <p>尚无候选或原候选已移除。</p>
          <p className="text-xs text-ink-subtle">先完善脚本，再从本镜生成清单开始。</p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {candidate && !adopted && (
        <>
          <p className="text-xs">
            {adoptedResult ? '历史预览，当前采用项保持不变。' : '尚未采用，此为待选候选。'}
            原验收：
            {historyReview ? reviewLabels[historyReview.status] : '未记录'}
          </p>
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            disabled={!writable() || !validNode()}
            onClick={() => {
              const now = engine.doc.get(node.id)?.results?.find((r) => r.id === candidate.id)
              if (!writable() || !validNode() || JSON.stringify(now) !== JSON.stringify(candidate))
                return setError('候选或目标已变化，未采用')
              adoptResult(engine.doc, node.id, candidate.id)
              setError('')
            }}
          >
            采用候选
          </button>
        </>
      )}
      {generationRole && (!candidate || adopted) && (
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={!writable() || !validNode()}
          onClick={() => onGenerate(generationRole)}
        >
          {generationRole === 'image' ? '生成镜头图' : '生成视频'}
        </button>
      )}
      {adopted && candidate && !generationRole && historyReview?.status === 'changes' && (
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={!writable() || !validNode()}
          onClick={() => {
            const role = (node.params?.source as ShotSource | undefined)?.role
            if (writable()) onGenerate(role ?? 'video')
          }}
        >
          重新生成{roles[(node.params?.source as ShotSource | undefined)?.role ?? 'video']}
        </button>
      )}
      {adopted &&
        candidate &&
        !generationRole &&
        historyReview?.status !== 'changes' &&
        (!historyReview || historyReview.status === 'pending') && (
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            disabled={!writable() || !validNode()}
            onClick={() => {
              const details = reviewContainer.current?.querySelector('details')
              if (details) {
                details.open = true
                details.querySelector('textarea')?.focus()
              }
            }}
          >
            审阅
          </button>
        )}
      {adopted && candidate && (
        <div ref={reviewContainer}>
          <CreativeReviewForm
            doc={engine.doc}
            node={node}
            port={candidate.port}
            stale={stale}
            isCurrent={() => validNode() && writable()}
          />
        </div>
      )}
      {refs.length > 0 && (
        <details>
          <summary>当前引用与实际送入</summary>
          {refs.map((u) => (
            <p key={u.edgeId} className="text-xs break-all">
              {u.source.name ?? u.source.id} · {u.value?.type ?? '未就绪'}
              {'assetId' in (u.value ?? {}) ? ` · ${(u.value as { assetId: string }).assetId}` : ''}
            </p>
          ))}
        </details>
      )}
      <details className="plein-shot-input-evidence">
        <summary>生成依据与输入对照</summary>
        <div className="grid gap-2 compact:grid-cols-2" aria-label="旧候选与当前输入对照">
          <section>
            <h4 className="text-sm font-medium">此候选生成时实际输入</h4>
            {!candidate?.runId ? (
              <p className="text-xs">未记录生成任务，不能用当前参数补填。</p>
            ) : old.isPending ? (
              <p>读取旧依据…</p>
            ) : old.isError || !old.data?.input ? (
              <p className="text-xs">旧依据未记录或不可读取；不以当前输入替代。</p>
            ) : (
              <InputDetails input={old.data.input} />
            )}
          </section>
          <section>
            <h4 className="text-sm font-medium">当前节点实际输入</h4>
            {current.isPending ? (
              <p>核对当前输入…</p>
            ) : current.isError ? (
              <p>当前输入暂不可读取。</p>
            ) : (
              current.data && <InputDetails input={current.data} />
            )}
          </section>
        </div>
      </details>
      {recovery && latest && (
        <div role="status" className="rounded-md border border-line p-2 text-xs">
          <p>{recovery.title}</p>
          {recovery.detail && <p>{recovery.detail}</p>}
          <button
            type="button"
            className="ui-btn ui-btn-secondary"
            onClick={() => {
              if (validNode()) {
                onLocate()
                useCanvas.getState().toggleTasks(true)
              }
            }}
          >
            定位原节点与任务恢复
          </button>
        </div>
      )}
      <button
        type="button"
        className="ui-btn ui-btn-secondary"
        onClick={() => {
          if (validNode()) onLocate()
          else setError('阶段身份已变化，未定位旧目标')
        }}
      >
        定位此阶段画布节点
      </button>
    </>
  )
}

function CandidateMedia({ result }: { result: NodeResult }) {
  const media = useRef<HTMLMediaElement>(null)
  useEffect(() => {
    const element = media.current
    return () => {
      if (element) {
        element.pause()
        element.removeAttribute('src')
        element.load()
      }
    }
  }, [])
  const value = result.value
  if (value.type === 'image')
    return (
      <img
        loading="lazy"
        className="plein-shot-preview-media"
        src={assetUrls.original(value.assetId)}
        alt="当前查看的具体候选"
      />
    )
  if (value.type === 'video')
    return (
      // oxlint-disable-next-line jsx-a11y/media-has-caption -- 审看原始候选，没有凭空创建字幕轨
      <video
        ref={(el) => {
          media.current = el
        }}
        controls
        playsInline
        preload="metadata"
        className="plein-shot-preview-media"
        src={assetUrls.original(value.assetId)}
        aria-label="工作台候选视频"
      />
    )
  if (value.type === 'audio')
    return (
      // oxlint-disable-next-line jsx-a11y/media-has-caption -- 审听原始候选，没有凭空创建字幕轨
      <audio
        ref={(el) => {
          media.current = el
        }}
        controls
        preload="metadata"
        src={assetUrls.original(value.assetId)}
        aria-label="工作台候选声音"
      />
    )
  return (
    <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs">
      {value.type === 'text'
        ? value.text
        : JSON.stringify(value.type === 'json' ? value.value : value, null, 2)}
    </pre>
  )
}

function InputDetails({ input }: { input: PreparedInput }) {
  return (
    <div className="space-y-1 text-xs">
      <p>
        {input.model?.title ?? input.model?.ref ?? '模型未设置或未记录'} · {input.status}
      </p>
      <p className="whitespace-pre-wrap break-words">{input.prompt ?? '提示词未记录'}</p>
      <p>参考 {input.refs.length} 项 · 费用以执行清单为准</p>
      <details>
        <summary>生效参数、送入值与依据版本</summary>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all">
          {JSON.stringify(
            {
              v: input.v,
              inputHash: input.inputHash,
              params: input.params,
              inputs: input.inputs,
              refs: input.refs,
            },
            null,
            2,
          )}
        </pre>
      </details>
      {[
        ...new Map(
          [...input.blocked, ...input.notices].map((n) => [JSON.stringify(n), n] as const),
        ).entries(),
      ].map(([key, n]) => (
        <p key={key}>{n.message}</p>
      ))}
    </div>
  )
}
