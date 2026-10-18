import { Dialog } from '@base-ui/react/dialog'
import {
  API,
  type DependencyStatus,
  type Project,
  type ProjectImportPreview,
  type ProjectImportResult,
} from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { useClosing, useExit } from '../../ui/Presence'
import { bytes } from '../../ui/format'
import { Switch } from '../../ui/Switch'

/**
 * 项目包（.plein）：导出对话框说明默认范围、可选带上历史候选；
 * 导入先上传预检，列出缺的模型、音色、插件和素材，确认后才写入。
 */

function PackageDialog({
  title,
  onClose,
  children,
  actions,
}: {
  title: string
  onClose(): void
  children: ReactNode
  actions: ReactNode
}) {
  const closing = useClosing()
  const exit = useExit()
  return (
    <Dialog.Root open={!closing} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop {...exit} className="ui-dialog-scrim fixed inset-0 z-60 bg-scrim" />
        <Dialog.Viewport className="fixed inset-0 z-60 flex items-center justify-center p-6">
          <Dialog.Popup
            {...exit}
            aria-label={title}
            className="ui-dialog relative flex max-h-full w-full max-w-120 flex-col gap-5 rounded-2xl bg-surface p-6 shadow-4 outline-none"
          >
            <h2 className="text-lg font-semibold">{title}</h2>
            <div className="ui-scrollbar -mx-6 flex min-h-0 flex-col gap-4 overflow-y-auto px-6 text-sm">
              {children}
            </div>
            <div className="flex justify-end gap-2">{actions}</div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

const counts = (c: {
  canvases: number
  assets: number
  library: number
  jobs: number
  checkpoints?: number
}) =>
  [
    `${c.canvases} 张画布`,
    `${c.assets} 个素材`,
    c.library && `${c.library} 个资产库条目`,
    c.jobs && `${c.jobs} 条运行记录`,
    c.checkpoints && `${c.checkpoints} 个检查点`,
  ]
    .filter(Boolean)
    .join(' · ')

export function ExportPackageDialog({ project, onClose }: { project: Project; onClose(): void }) {
  const [history, setHistory] = useState(false)
  const summary = useQuery({
    queryKey: ['projectPackage', project.id, history],
    queryFn: () => api.projectPackageSummary(project.id, history),
  })
  const s = summary.data
  const download = () => {
    const a = document.createElement('a')
    a.href = API.projectPackage(project.id, history)
    a.download = `${project.title.replace(/[\\/:*?"<>|]/g, '_')}.plein`
    a.click()
    onClose()
  }
  return (
    <PackageDialog
      title="导出项目包"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="ui-btn ui-btn-secondary ui-btn-lg" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-primary ui-btn-lg"
            disabled={!s || s.tooLarge || summary.isFetching || !!summary.error}
            onClick={download}
          >
            导出
          </button>
        </>
      }
    >
      <p className="leading-5 text-ink-muted">
        把「{project.title}」打包成一个 .plein 文件，在另一台电脑或另一个数据目录里导入后继续编辑。
      </p>
      <div className="flex flex-col gap-1.5">
        <div className="ui-section-title">包含</div>
        <p className="leading-5">
          全部画布、画布用到的素材、资产库条目、每个节点当前采用的结果和运行记录，以及全部命名检查点和检查点保留的素材。运行记录只作历史，导入后不会续查或重新提交。
        </p>
        <div className="ui-section-title mt-2">不包含</div>
        <p className="leading-5">
          平台密钥、登录信息和智能体会话。模型、音色和插件只记标识，导入后在设置里重新配置。
        </p>
      </div>
      <div className="flex items-center justify-between gap-4">
        <span>
          <span className="block">包含历史候选</span>
          <span className="ui-help">包含未采用的候选；检查点始终完整保留</span>
        </span>
        <Switch checked={history} label="包含历史候选" onChange={setHistory} />
      </div>
      <div className="text-xs text-ink-subtle" aria-live="polite">
        {summary.isFetching
          ? '正在统计…'
          : summary.error
            ? `读取失败：${summary.error.message}`
            : s
              ? `${counts(s)} · 约 ${bytes(s.bytes)}`
              : '正在统计…'}
      </div>
      {summary.error && (
        <button
          type="button"
          className="ui-btn ui-btn-secondary self-start"
          disabled={summary.isFetching}
          onClick={() => void summary.refetch()}
        >
          {summary.isFetching ? '正在统计…' : '重新统计'}
        </button>
      )}
      {s?.tooLarge && (
        <p className="text-danger">项目包超过 4 GB：关掉「包含历史候选」再试，或者整目录备份。</p>
      )}
      {s && s.missing.length > 0 && (
        <p className="text-ink-muted">
          有 {s.missing.length} 处引用在本机找不到（{missingText(s.missing)}），会作为缺失记在包里。
        </p>
      )}
    </PackageDialog>
  )
}

const missingText = (list: ProjectImportPreview['missing']) =>
  list
    .slice(0, 3)
    .map((m) => m.where)
    .join('、') + (list.length > 3 ? ' 等' : '')

const STATUS: Record<DependencyStatus, { label: string; tone: string }> = {
  ok: { label: '可用', tone: 'ui-tag-success' },
  missing: { label: '未安装', tone: 'ui-tag-warning' },
  disabled: { label: '未启用', tone: 'ui-tag-warning' },
  outdated: { label: '版本较旧', tone: 'ui-tag-warning' },
  unverified: { label: '需确认', tone: '' },
}

function DependencyRow({ label, status }: { label: string; status: DependencyStatus }) {
  const s = STATUS[status]
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
      <span className={`ui-tag shrink-0 ${s.tone}`}>{s.label}</span>
    </li>
  )
}

type ImportState =
  | { step: 'checking' }
  | { step: 'error'; message: string }
  | { step: 'preview'; preview: ProjectImportPreview; busy?: boolean }

/** 选好文件后：上传预检 → 展示结果 → 确认导入或放弃 */
export function ImportPackageDialog({
  file,
  onClose,
  onImported,
}: {
  file: File
  onClose(): void
  onImported(result: ProjectImportResult): void
}) {
  const [state, setState] = useState<ImportState>({ step: 'checking' })
  const token = useRef<string | null>(null)
  const done = useRef(false)

  useEffect(() => {
    let alive = true
    api.inspectProjectPackage(file).then(
      (preview) => {
        token.current = preview.token
        if (alive) setState({ step: 'preview', preview })
        else void api.discardProjectImport(preview.token).catch(() => {})
      },
      (err: Error) => alive && setState({ step: 'error', message: err.message }),
    )
    return () => {
      alive = false
    }
  }, [file])

  const cancel = () => {
    if (token.current && !done.current) void api.discardProjectImport(token.current).catch(() => {})
    onClose()
  }
  const confirm = async (preview: ProjectImportPreview) => {
    setState({ step: 'preview', preview, busy: true })
    try {
      const result = await api.commitProjectImport(preview.token)
      done.current = true
      onImported(result)
    } catch (err) {
      done.current = true
      setState({ step: 'error', message: (err as Error).message })
    }
  }

  if (state.step !== 'preview')
    return (
      <PackageDialog
        title={state.step === 'checking' ? '导入项目包' : '无法导入'}
        onClose={cancel}
        actions={
          <button type="button" className="ui-btn ui-btn-secondary ui-btn-lg" onClick={cancel}>
            {state.step === 'checking' ? '取消' : '关闭'}
          </button>
        }
      >
        {state.step === 'checking' ? (
          <p className="flex items-center gap-2 text-ink-muted">
            <span className="ui-spinner size-4" />
            正在校验 {file.name}…
          </p>
        ) : (
          <p className="leading-5 text-danger">{state.message}</p>
        )}
      </PackageDialog>
    )

  const { preview: p, busy } = state
  const models = p.models.filter((m) => m.status !== 'ok')
  const nodes = p.nodes.filter((n) => n.status !== 'ok')
  return (
    <PackageDialog
      title={`导入「${p.title}」`}
      onClose={cancel}
      actions={
        <>
          <button type="button" className="ui-btn ui-btn-secondary ui-btn-lg" onClick={cancel}>
            取消
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-primary ui-btn-lg"
            disabled={busy}
            onClick={() => void confirm(p)}
          >
            {busy ? '正在导入…' : p.copy ? '作为副本导入' : '导入'}
          </button>
        </>
      }
    >
      <p className="text-ink-muted">
        {counts(p.counts)} · {bytes(p.counts.bytes)}
      </p>
      {p.copy && (
        <p className="leading-5">
          本机已经有这个项目，会作为副本导入：项目、画布、项目自己的资产库条目和运行记录都换新
          id，画布里的引用一起改，原项目不受影响。
        </p>
      )}
      {p.reusedLibrary > 0 && (
        <p className="leading-5 text-ink-muted">
          {p.reusedLibrary} 个资产库条目本机已有，直接沿用，不再重复添加。
        </p>
      )}
      {(models.length > 0 || nodes.length > 0 || p.voices.length > 0) && (
        <div className="flex flex-col gap-2">
          <div className="ui-section-title">依赖</div>
          <ul className="flex flex-col gap-1.5">
            {models.map((m) => (
              <DependencyRow key={m.ref} label={`模型 ${m.ref}`} status={m.status} />
            ))}
            {nodes.map((n) => (
              <DependencyRow
                key={`${n.type}@${n.version}`}
                label={`节点 ${n.type}（第 ${n.version} 版${n.plugin ? `，${n.plugin}` : ''}）`}
                status={n.status}
              />
            ))}
            {p.voices.map((v) => (
              <DependencyRow
                key={`${v.provider}/${v.voiceId}`}
                label={`音色 ${v.voiceId}${v.provider ? `（${v.provider}）` : ''}`}
                status={v.status}
              />
            ))}
          </ul>
          <p className="ui-help">
            未安装、未启用的模型在设置里启用对应平台或改选别的模型；音色属于平台账户，生成配音前确认还能用。
          </p>
        </div>
      )}
      {p.missing.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="ui-section-title">缺失的素材</div>
          <p className="leading-5 text-ink-muted">
            导出时就找不到 {p.missing.length} 处引用（{missingText(p.missing)}），导入后仍然缺失。
          </p>
        </div>
      )}
      <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-ink-subtle">
        {p.notices.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </PackageDialog>
  )
}
