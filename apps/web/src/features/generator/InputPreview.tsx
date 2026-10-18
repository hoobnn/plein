import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, setParam } from '@plein/doc'
import type { InputIssue, InputRef, InputRefKind, PreparedInput } from '@plein/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, assetUrls } from '../../api/client'
import { fieldsOf, type NodeInfo } from '../../canvas/nodes'
import { Icon } from '../../ui/icons'

/** 改动后多久重新准备一次实际输入：打字时不逐字请求 */
const DEBOUNCE_MS = 400

/**
 * 节点的实际输入（服务端准备，不调用付费生成）。文档有改动时防抖后重新拉；
 * setData 用于提交时服务端发现输入变了、带回的新结果
 */
export function useInputPreview(engine: Engine, canvasId: string | null, nodeId: string) {
  const [data, setData] = useState<PreparedInput | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)
  const [rev, setRev] = useState(0)
  useEffect(() => engine.doc.subscribe(() => setRev((r) => r + 1)), [engine])
  useEffect(() => {
    if (!canvasId) return
    let live = true
    const id = ++requestId.current
    const current = () => live && id === requestId.current
    setLoading(true)
    setError(null)
    const timer = setTimeout(() => {
      api
        .nodeInput(canvasId, nodeId)
        .then((r) => current() && setData(r))
        // 保留旧输入供查看，但必须标明刷新失败；不能把旧阻断当成现在的状态。
        .catch((err: unknown) => current() && setError((err as Error).message))
        .finally(() => current() && setLoading(false))
    }, DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [canvasId, nodeId, rev])
  // 换画布或节点时不显示上一个对象的结果。
  useEffect(() => setData(null), [canvasId, nodeId])
  const replaceData = useCallback((next: PreparedInput) => {
    // 提交的 409 回执比此前发出的预览请求新，尚在路上的响应不能覆盖它。
    requestId.current++
    setData(next)
    setError(null)
    setLoading(false)
  }, [])
  return {
    data: data?.nodeId === nodeId ? data : null,
    loading,
    error,
    retry: () => setRev((r) => r + 1),
    setData: replaceData,
  }
}

const KIND_LABEL: Record<InputRefKind, string> = {
  character: '角色',
  scene: '场景',
  prop: '道具',
  style: '风格',
  image: '图片',
  other: '引用',
}

/** 引用的用法标签：送了几张、为什么没送 */
function refState(r: InputRef): { text: string; tone: string; title?: string } {
  if (r.reason === 'failed')
    return { text: '参考图失败', tone: 'ui-tag-warning', title: '参考图生成失败，只附文字设定' }
  if (r.reason === 'no_image')
    return { text: '无参考图', tone: 'ui-tag-warning', title: '还没有可用的参考图，只附文字设定' }
  if (r.reason === 'unsupported')
    return { text: '只附文字', tone: 'ui-tag', title: '当前模式不送参考图，只附文字设定' }
  if (r.reason === 'over_limit')
    return r.sent.length
      ? {
          text: `送入 ${r.sent.length}/${r.available.length} 张`,
          tone: 'ui-tag-warning',
          title: '超过模型的参考图上限，其余的没有送入',
        }
      : { text: '超出上限', tone: 'ui-tag-warning', title: '超过模型的参考图上限，只附文字设定' }
  return { text: `送入 ${r.sent.length} 张`, tone: 'ui-tag-success' }
}

/** 提示和阻断给人看的文案；同一条提示可能按引用记了多次，只显示一次 */
export function issueText(issues: InputIssue[]) {
  return [...new Set(issues.map((i) => i.message))]
}

/** 摘要一行：模型、参考图张数、降级和阻断数 */
function previewSummary(p: PreparedInput) {
  const refs = Object.values(p.inputs)
    .flat()
    .filter((v) => v.type === 'image').length
  const parts = [p.model ? `${p.model.title}${p.model.auto ? '（自动）' : ''}` : '未选模型']
  if (refs) parts.push(`${refs} 张参考图`)
  const values = Object.values(p.inputs).flat()
  const videos = values.filter((value) => value.type === 'video').length
  const audios = values.filter((value) => value.type === 'audio').length
  if (videos) parts.push(`${videos} 段参考视频`)
  if (audios) parts.push(`${audios} 段参考音频`)
  if (p.voice) parts.push(`音色 ${p.voice.voiceId}`)
  return parts.join(' · ')
}

/**
 * 生成前的实际输入：最终提示词、送入的参考图及顺序、每个 @ 引用的用法与原因、模型与有效参数。
 * 引用可设为必需：必需参考先占名额，缺图或放不下时不提交。
 */
export function InputPreview({
  engine,
  el,
  node,
  data,
  loading,
  error,
  onRetry,
}: {
  engine: Engine
  el: CanvasElement
  node: NodeInfo
  data: PreparedInput | null
  loading: boolean
  error: string | null
  onRetry(): void
}) {
  const [open, setOpen] = useState(false)
  const status = error ? (
    <div role="alert" className="flex items-start gap-2 text-xs text-warning">
      <p className="min-w-0 flex-1">
        读取实际输入失败：{error}。
        {data ? '下面是上次读取的输入，尚未确认当前状态。' : '尚未取得实际输入。'}
      </p>
      <button
        type="button"
        className="ui-btn ui-btn-xs ui-btn-secondary flex-none"
        onClick={onRetry}
      >
        重新读取实际输入
      </button>
    </div>
  ) : loading ? (
    <p role="status" className="text-xs text-ink-subtle">
      {data ? '正在更新实际输入，下面暂时显示上次读取的输入。' : '正在读取实际输入…'}
    </p>
  ) : null
  if (!data)
    return status ? (
      <div className="px-4 pt-3" data-testid="input-preview" aria-busy={loading}>
        {status}
      </div>
    ) : null
  const fields = new Map(fieldsOf(node))
  const canRequire = fields.has('requiredRefs')
  const required = Array.isArray(el.params?.requiredRefs)
    ? (el.params.requiredRefs as string[])
    : []
  const toggleRequired = (id: string) =>
    setParam(
      engine.doc,
      el.id,
      'requiredRefs',
      required.includes(id) ? required.filter((x) => x !== id) : [...required, id],
    )
  // 送入的图标上来自哪个引用；自己连入的图用上游元素名
  const nameOf = (assetId: string | undefined, source: string | undefined) =>
    data.refs.find((r) => assetId && r.sent.includes(assetId))?.name ??
    ((source && engine.doc.get(source)?.name) || '连入')
  const images = Object.entries(data.inputs).flatMap(([port, values]) =>
    values
      .filter((v) => v.type === 'image' || v.type === 'video' || v.type === 'audio')
      .map((v) => ({ ...v, port })),
  )
  const params = Object.entries(data.params).filter(
    ([k, v]) => k !== 'model' && v !== '' && v !== undefined && typeof v !== 'object',
  )
  const issues = data.blocked.length + data.notices.length

  return (
    <div className="px-4 pt-3" data-testid="input-preview" aria-busy={loading}>
      {status}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="ui-btn ui-btn-quiet ui-btn-sm -ml-2.5 max-w-full"
      >
        <span className="flex-none">实际输入</span>
        <span className="truncate text-ink-subtle">{previewSummary(data)}</span>
        {!loading && !error && data.blocked.length > 0 ? (
          <span className="ui-tag ui-tag-danger">不会提交</span>
        ) : (
          issues > 0 && <span className="ui-tag ui-tag-warning">{issues} 条提示</span>
        )}
        {loading && <span className="ui-spinner size-3" aria-label="更新中" />}
        <span className={`flex-none transition-transform ${open ? 'rotate-180' : ''}`}>
          <Icon name="chevronDown" size={14} />
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 pt-2 pb-1 text-xs">
          {data.refs.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <h4 className="ui-section-title">
                @ 引用
                {data.referenceLimit !== undefined && (
                  <span className="font-normal text-ink-subtle">
                    {' '}
                    · 模型最多 {data.referenceLimit} 张参考图
                  </span>
                )}
              </h4>
              {data.refs.map((r) => {
                const state = refState(r)
                const thumb = r.sent[0] ?? r.available[0]
                return (
                  <div key={`${r.elementId}-${r.name}`} className="flex items-center gap-2">
                    <span className="relative size-8 flex-none overflow-hidden rounded-sm bg-surface-2">
                      {thumb ? (
                        <img
                          src={assetUrls.variant(thumb, 'thumb-256')}
                          alt=""
                          className={`size-full object-cover ${r.sent.length ? '' : 'opacity-40'}`}
                        />
                      ) : (
                        <span className="flex size-full items-center justify-center text-ink-subtle">
                          <Icon name="image" size={14} />
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-ink">
                      {r.name}
                      <span className="text-ink-subtle"> · {KIND_LABEL[r.kind]}</span>
                    </span>
                    <span className={`ui-tag ${state.tone}`} title={state.title}>
                      {state.text}
                    </span>
                    {canRequire && (
                      <button
                        type="button"
                        onClick={() => toggleRequired(r.elementId)}
                        aria-pressed={r.required}
                        title={
                          r.required
                            ? '必需参考：缺图或放不下时不提交。点击改为可选'
                            : '设为必需参考：优先送入，缺图或放不下时不提交'
                        }
                        className={`ui-btn ui-btn-xs ${r.required ? 'ui-btn-secondary text-accent' : 'ui-btn-quiet text-ink-subtle'}`}
                      >
                        <Icon name="star" size={12} />
                        {r.required ? '必需' : '可选'}
                      </button>
                    )}
                  </div>
                )
              })}
            </section>
          )}
          {images.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <h4 className="ui-section-title">送入顺序</h4>
              <div className="ui-scrollbar flex gap-2 overflow-x-auto pb-0.5">
                {images.map((v, i) => (
                  <figure
                    key={`${v.port}-${v.assetId}`}
                    className="flex w-12 flex-none flex-col items-center gap-1 text-2xs text-ink-subtle"
                    title={nameOf(v.assetId, v.source)}
                  >
                    <span className="relative size-12 overflow-hidden rounded-md bg-surface-2 shadow-1">
                      {v.type === 'audio' ? (
                        <span className="flex size-full items-center justify-center">
                          <Icon name="sound" size={20} />
                        </span>
                      ) : (
                        <img
                          src={assetUrls.variant(
                            v.assetId!,
                            v.type === 'video' ? 'poster' : 'thumb-256',
                          )}
                          alt=""
                          className="size-full object-cover"
                        />
                      )}
                      <span className="ui-badge absolute top-1 left-1 tabular-nums">{i + 1}</span>
                    </span>
                    <figcaption className="w-full truncate text-center">
                      {v.type === 'video' ? '视频 · ' : v.type === 'audio' ? '音频 · ' : ''}
                      {nameOf(v.assetId, v.source)}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
          )}
          {data.prompt && (
            <section className="flex flex-col gap-1.5">
              <h4 className="ui-section-title">最终提示词</h4>
              <p className="ui-scrollbar max-h-32 overflow-y-auto rounded-md bg-surface-2 px-2.5 py-2 whitespace-pre-wrap text-ink">
                {data.prompt}
              </p>
            </section>
          )}
          {(params.length > 0 || data.voice) && (
            <section className="flex flex-wrap items-center gap-1.5">
              <h4 className="ui-section-title mr-1">有效参数</h4>
              {data.voice && <span className="ui-chip">音色 {data.voice.voiceId}</span>}
              {params.map(([k, v]) => (
                <span key={k} className="ui-chip">
                  {fields.get(k)?.title ?? k}{' '}
                  {fields.get(k)?.labels?.[String(v)] ??
                    (typeof v === 'boolean' ? (v ? '开启' : '关闭') : String(v))}
                </span>
              ))}
            </section>
          )}
          {data.notices.length > 0 && (
            <ul className="flex flex-col gap-1 text-ink-subtle">
              {issueText(data.notices).map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
