import type { PreparedInput } from '@plein/protocol'

const ORIGIN_LABEL = {
  edge: '连线',
  mention: '引用',
  role: '角色',
  continuation: '续写',
  binding: '绑定',
} as const

const ROLE_LABEL = { firstFrame: '首帧', lastFrame: '尾帧' } as const

/** 一次准备结果的可读摘要：实际送入的参考、未送入原因，生效参数收进展开区。 */
export function InputDetails({ input }: { input: PreparedInput }) {
  const sentKnown = Array.isArray(input.sent)
  const sent = input.sent ?? []
  const unsent = input.unsent ?? []
  return (
    <div className="space-y-1 text-xs">
      <p>
        {input.model?.title ?? input.model?.ref ?? '模型未设置或未记录'} · {input.status}
      </p>
      <p className="whitespace-pre-wrap break-words">{input.prompt ?? '提示词未记录'}</p>
      {sent.length > 0 && (
        <ul aria-label="实际送入的参考素材" className="space-y-0.5 text-ink-subtle">
          {sent.map((ref) => (
            <li key={`${ref.index}:${ref.assetId}:${ref.role ?? ''}`} className="break-all">
              {ref.role ? ROLE_LABEL[ref.role] : ref.token} · {ref.name}
              {ref.origins.length > 0
                ? `（${[...new Set(ref.origins)].map((origin) => ORIGIN_LABEL[origin]).join('、')}）`
                : ''}
            </li>
          ))}
        </ul>
      )}
      <p>
        {sentKnown
          ? `实际送入参考 ${sent.length} 项`
          : `参考 ${input.refs.length} 项（旧记录未区分是否送入）`}
        {' · '}费用以执行清单为准
      </p>
      {unsent.length > 0 && (
        <details>
          <summary className="cursor-pointer">未送入 · {unsent.length}</summary>
          <ul className="space-y-0.5">
            {unsent.map((item) => (
              <li
                key={`${item.reason}:${item.elementId ?? ''}:${item.assetId ?? ''}:${item.name}`}
                className="break-all"
              >
                {item.name}：{item.message}
              </li>
            ))}
          </ul>
        </details>
      )}
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
