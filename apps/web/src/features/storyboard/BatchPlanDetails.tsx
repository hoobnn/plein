import type { StoryboardBatchPlan, StoryboardBatchRow } from '@plein/protocol'

const actions = { run: '本次生成', reuse: '沿用', blocked: '阻塞', skip: '跳过' }

/** UI 与 Agent 审批展示同一份冻结清单；不读取当前参数，不具备提交能力。 */
export function BatchPlanDetails({
  plan,
  busy = false,
  onLocate,
  onLocateMapping,
}: {
  plan: Omit<StoryboardBatchPlan, 'token'>
  busy?: boolean
  onLocate?(row: StoryboardBatchRow): void
  onLocateMapping?(row: StoryboardBatchRow, clipInstanceId: string): void
}) {
  const summary = plan.summary
  return (
    <div>
      {plan.scope && (
        <p aria-label="清单冻结范围" className="mb-2 break-all text-xs text-ink-subtle">
          画布 {plan.scope.canvasId} · 分镜 {plan.scope.boardId} · 序列{' '}
          {plan.scope.sequenceId ??
            (plan.scope.sequenceIds.length > 1 ? '尚未明确，请选择' : '无关联序列')}
        </p>
      )}
      <p aria-label="清单汇总" className="mb-4 text-sm">
        生成 {summary.run} 项 · 沿用 {summary.reuse} 项 · 阻塞 {summary.blocked} 项 · 跳过{' '}
        {summary.skip} 项 · 预计 {summary.calls} 次模型调用（不含自动重试）
        {summary.prices.map((price) => (
          <span key={price.currency}>
            {' '}
            · 配置估算 {price.amount.toFixed(2)} {price.currency}
          </span>
        ))}
        {summary.unknownCalls > 0 && <span> · {summary.unknownCalls} 次价格未知</span>}
      </p>
      <div className="ui-scrollbar overflow-auto">
        <table className="w-full text-left text-sm" aria-label="本次批量项目">
          <thead>
            <tr className="border-b border-line text-ink-muted">
              <th className="p-2">项目</th>
              <th className="p-2">处理</th>
              <th className="p-2">原因与实际输入</th>
              {onLocate && <th className="p-2">修复</th>}
            </tr>
          </thead>
          <tbody>
            {plan.rows.map((row) => (
              <tr key={row.key} className="border-b border-line align-top">
                <td className="p-2">
                  <p>{row.name}</p>
                  <p className="text-xs text-ink-subtle">
                    {row.prerequisite ? '资产准备' : row.shotNo ? `镜头 ${row.shotNo}` : ''}
                  </p>
                </td>
                <td className="whitespace-nowrap p-2">
                  {actions[row.action]}
                  {row.calls > 0 && <p className="text-xs text-ink-muted">预计 {row.calls} 次</p>}
                </td>
                <td className="max-w-120 p-2">
                  <p>{row.reason}</p>
                  {row.mapping && (
                    <details className="mt-1 text-xs text-ink-muted">
                      <summary className="cursor-pointer">查看固定段与声音映射</summary>
                      <p className="break-all">序列 {row.mapping.sequenceId}</p>
                      {row.mapping.instances.map((instance) => (
                        <div key={instance.clipInstanceId} className="break-all">
                          <p>
                            实例 {instance.clipInstanceId} ·{' '}
                            {instance.segmentId ? '固定段' : '跟随来源'}{' '}
                            {instance.segmentId ?? instance.source} · 端口 {instance.port} · 源区间
                            [{instance.in}, {instance.out ?? '文件结尾'}) · 声音 {instance.sound}
                            {instance.assetId ? ` · 文件 ${instance.assetId}` : ''}
                          </p>
                          {onLocateMapping && (
                            <button
                              type="button"
                              className="underline"
                              disabled={busy}
                              onClick={() => onLocateMapping(row, instance.clipInstanceId)}
                            >
                              定位此映射实例
                            </button>
                          )}
                        </div>
                      ))}
                      <p>
                        同段使用位置 {row.mapping.users.length}{' '}
                        处；新叙事不继承原出处的人工审看结论。
                      </p>
                      {row.mapping.users.map((user) => (
                        <p key={`${user.sequenceId}/${user.clipInstanceId}`} className="break-all">
                          {user.sequenceId} / {user.clipInstanceId}
                        </p>
                      ))}
                      {row.mapping.audioSources?.map((audio) => (
                        <p key={`${audio.source}/${audio.port}`} className="break-all">
                          复用配音：{audio.source} · 端口 {audio.port} · 文件 {audio.assetId} · 候选{' '}
                          {audio.resultId ?? '直接音频文件'} · 原任务 {audio.runId ?? '未知'}
                        </p>
                      ))}
                    </details>
                  )}
                  {row.input && (
                    <details className="mt-1 text-xs text-ink-muted">
                      <summary className="cursor-pointer">
                        查看实际输入{row.deferred ? '（资产准备后复核）' : ''}
                      </summary>
                      <p>{row.input.model?.title ?? '尚未选模型'}</p>
                      <p className="mt-1 whitespace-pre-wrap break-words">
                        {row.input.prompt ?? ''}
                      </p>
                      {row.input.nodeType === 'plein/video' &&
                        row.input.params.mode === 'image' && (
                          <p>
                            首帧：已送入 {(row.input.inputs.images ?? []).length} 张上游分镜图（来自
                            inputs.images）
                          </p>
                        )}
                      {row.input.nodeType === 'plein/video' &&
                        row.input.params.mode === 'reference' && (
                          <p>
                            实际送入模型：{(row.input.inputs.images ?? []).length} 张图片、
                            {(row.input.inputs.videos ?? []).length} 段视频、
                            {(row.input.inputs.audios ?? []).length} 段音频（包含连线和 @ 引用）
                          </p>
                        )}
                      {row.input.refs.map((ref) => (
                        <p key={ref.elementId}>
                          {ref.name}：作为 @ 引用直接送入 {ref.sent.length} 张参考图
                        </p>
                      ))}
                      {row.input.voice && <p>音色：{row.input.voice.voiceId}</p>}
                      <details>
                        <summary className="cursor-pointer">生效参数与参考顺序</summary>
                        <pre className="whitespace-pre-wrap break-words">
                          {JSON.stringify(
                            { params: row.input.params, inputs: row.input.inputs },
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                      {[...row.input.blocked, ...row.input.notices].map((notice) => (
                        <p key={`${notice.code}/${notice.elementId ?? ''}/${notice.message}`}>
                          {notice.message}
                        </p>
                      ))}
                    </details>
                  )}
                </td>
                {onLocate && (
                  <td className="p-2">
                    {row.nodeId && (
                      <button
                        type="button"
                        className="ui-btn ui-btn-quiet ui-btn-xs"
                        disabled={busy}
                        onClick={() => onLocate(row)}
                      >
                        定位
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
