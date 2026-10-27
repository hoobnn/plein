import { setParam, type PleinDoc } from '@plein/doc'
export function SpeechInstruction({
  doc,
  nodeId,
  instruction,
  focusPrompt,
}: {
  doc: PleinDoc
  nodeId: string
  instruction: string
  focusPrompt(): void
}) {
  return (
    <div className="flex items-start gap-2 px-1 text-xs text-ink-muted">
      <p className="min-w-0 flex-1 line-clamp-2 break-words" title={instruction}>
        当前模型不支持自由语气，已保留指令：{instruction}
      </p>
      <button
        type="button"
        className="ui-btn ui-btn-xs ui-btn-secondary shrink-0"
        onClick={() => {
          focusPrompt()
          setParam(doc, nodeId, 'instruction', '')
        }}
      >
        清空语气指令
      </button>
    </div>
  )
}
