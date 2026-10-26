import type { Project, ProviderInfo } from '@plein/protocol'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { invalidateProjects, queryClient, queryKeys } from '../../api/query'
import { DRAMA_START, queueStartNode } from '../../canvas/startQueue'
import { navigate } from '../../router'
import { useCatalog } from '../../stores/catalog'
import { useCanvas } from '../../stores/canvas'
import { Icon, type IconName } from '../../ui/icons'
import { Modal } from '../../ui/Modal'
import { Presence, useClosing } from '../../ui/Presence'
import { SlideSwap } from '../../ui/Slide'
import { ProviderRow } from '../settings/ProviderSettings'

const DONE_KEY = 'plein.welcome'
/** 推荐先接入的平台排在前面（0.1.0 的 P0） */
const RECOMMENDED = ['volc/ark', 'doubao/speech']

function welcomed() {
  try {
    return localStorage.getItem(DONE_KEY) === '1'
  } catch {
    return true
  }
}

function markWelcomed() {
  try {
    localStorage.setItem(DONE_KEY, '1')
  } catch {}
}

const usable = (p: ProviderInfo) => p.enabled && p.configured

/**
 * 首次启动引导：还没有任何可用的模型平台时，在首页弹出。
 * 第一步填平台密钥并测试连接，第二步从短剧模板或空白画布开始；随时可以跳过，之后在设置里改。
 */
export function Welcome() {
  const { catalog, load } = useCatalog()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    // 只在打开首页时判断一次：引导里填好密钥后不会因为“已有可用平台”而突然消失
    if (catalog && !welcomed() && !catalog.providers.some(usable)) setOpen(true)
  }, [catalog])
  const close = () => {
    markWelcomed()
    setOpen(false)
  }
  return <Presence>{open && catalog && <WelcomeDialog onClose={close} />}</Presence>
}

function WelcomeDialog({ onClose }: { onClose(): void }) {
  const { catalog, load } = useCatalog()
  const [step, setStep] = useState(0)
  const [openProvider, setOpenProvider] = useState<string | null>(RECOMMENDED[0]!)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const active = useRef(true)
  const closing = useClosing()
  useEffect(() => {
    active.current = !closing
    return () => {
      active.current = false
    }
  }, [closing])
  const dismiss = () => {
    active.current = false
    onClose()
  }

  const providers = [...(catalog?.providers ?? [])]
    .filter((p) => p.id !== 'plein/mock')
    .sort((a, b) => rank(a.id) - rank(b.id))
  const ready = (catalog?.providers ?? []).filter(usable)

  const start = async (type?: string) => {
    if (pending.current || !active.current || closing) return
    pending.current = true
    setCreating(true)
    setError(null)
    try {
      const p = await api.createProject()
      if (!p.lastCanvasId) throw new Error('项目建好了，但没有画布')
      if (type) queueStartNode(p.lastCanvasId, type)
      queryClient.setQueryData<Project[]>(queryKeys.projects, (items) => [
        p,
        ...(items ?? []).filter((item) => item.id !== p.id),
      ])
      void invalidateProjects()
      if (active.current) {
        dismiss()
        navigate({ name: 'canvas', id: p.lastCanvasId })
      } else useCanvas.getState().notify(`已创建项目「${p.title}」`)
    } catch (err) {
      pending.current = false
      void invalidateProjects()
      if (active.current) {
        setError((err as Error).message)
        setCreating(false)
      } else useCanvas.getState().notify(`创建项目未获确认：${(err as Error).message}`)
    }
  }

  return (
    <Modal label="欢迎使用 Plein" onClose={dismiss} className="max-w-150">
      <header className="flex flex-none items-start gap-3 px-6 pt-6 pb-4">
        <span className="plein-logo size-9 flex-none" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">欢迎使用 Plein</h2>
          <p className="mt-0.5 text-sm text-ink-subtle">
            从一句创意开始，剧本、分镜、镜头与配音在画布上铺开，和 AI Agent 一起完成你的作品。
          </p>
        </div>
        <button
          type="button"
          aria-label="关闭"
          title="关闭（Esc）"
          onClick={dismiss}
          className="ui-btn ui-btn-quiet ui-icon-btn"
        >
          <Icon name="x" />
        </button>
      </header>
      <ol aria-label="步骤" className="flex flex-none items-center gap-2 px-6 pb-4 text-xs">
        {['连接模型平台', '开始创作'].map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            {i > 0 && <span className="h-px w-6 bg-line" aria-hidden="true" />}
            <span
              aria-current={i === step ? 'step' : undefined}
              className={`flex items-center gap-1.5 transition-colors ${
                i === step ? 'text-ink' : 'text-ink-subtle'
              }`}
            >
              <span
                className={`flex size-5 items-center justify-center rounded-full text-2xs tabular-nums transition-colors ${
                  i < step
                    ? 'bg-accent text-on-accent'
                    : i === step
                      ? 'bg-primary text-on-primary'
                      : 'bg-surface-2'
                }`}
              >
                {i < step ? <Icon name="check" size={12} /> : i + 1}
              </span>
              {label}
            </span>
          </li>
        ))}
      </ol>

      <div className="ui-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-6 pb-2">
        <SlideSwap index={step} className="flex flex-col gap-4">
          {step === 0 ? (
            <>
              <p className="text-sm text-ink-muted">
                Plein 用你自己的模型平台账号生成剧本、图片、视频和配音。推荐先接入
                <b className="font-medium text-ink">火山方舟</b>（文本、图像、视频）和
                <b className="font-medium text-ink">豆包语音</b>（配音）。密钥只保存在这台电脑上。
              </p>
              <ul className="rounded-lg ring-1 ring-line">
                {providers.map((p) => (
                  <ProviderRow
                    key={p.id}
                    provider={p}
                    open={openProvider === p.id}
                    onToggleOpen={() => setOpenProvider(openProvider === p.id ? null : p.id)}
                    onSaved={load}
                    enableOnSave
                  />
                ))}
              </ul>
            </>
          ) : (
            <>
              <p className="text-sm text-ink-muted">
                {ready.length
                  ? `已可以使用：${ready.map((p) => p.title).join('、')}。选一种方式开始：`
                  : '还没有可用的模型平台。可以先把流程搭好，运行前再到设置里填密钥。'}
              </p>
              <div className="grid gap-3">
                <StartCard
                  icon="workflow"
                  title="从短剧模板开始"
                  hint="剧本、分镜、镜头、配音配乐到成片的完整流程，插入时不调用模型"
                  disabled={creating}
                  onClick={() => void start(DRAMA_START)}
                />
                <StartCard
                  icon="plus"
                  title="空白画布"
                  hint="拖入图片、视频、音频、Markdown 或整个文件夹，自由搭建"
                  disabled={creating}
                  onClick={() => void start()}
                />
              </div>
              {creating && (
                <div className="space-y-1">
                  <p role="status" className="flex items-center gap-2 text-sm text-ink-muted">
                    <span className="ui-spinner size-4" />
                    正在创建项目…
                  </p>
                  <p className="ui-help">关闭引导不会取消创建，可稍后在项目列表查看结果。</p>
                </div>
              )}
              {error && (
                <p role="alert" className="text-sm text-danger">
                  创建失败：{error}
                </p>
              )}
            </>
          )}
        </SlideSwap>
      </div>

      <footer className="flex flex-none items-center gap-2 border-t border-line px-6 py-4">
        {step === 0 ? (
          <>
            <span className="mr-auto text-xs text-ink-subtle">之后可以在 设置 → 模型平台 修改</span>
            <button type="button" onClick={() => setStep(1)} className="ui-btn ui-btn-quiet">
              跳过
            </button>
            <button
              type="button"
              onClick={() => setStep(1)}
              disabled={!ready.length}
              className="ui-btn ui-btn-primary"
            >
              下一步
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setStep(0)}
              disabled={creating}
              className="ui-btn ui-btn-quiet mr-auto"
            >
              <Icon name="chevronLeft" />
              上一步
            </button>
            <button type="button" onClick={dismiss} className="ui-btn ui-btn-quiet">
              先看看项目列表
            </button>
          </>
        )}
      </footer>
    </Modal>
  )
}

function rank(id: string) {
  const i = RECOMMENDED.indexOf(id)
  return i === -1 ? RECOMMENDED.length : i
}

function StartCard(props: {
  icon: IconName
  title: string
  hint: string
  disabled: boolean
  onClick(): void
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className="home-quick group ring-1 ring-line"
    >
      <span className="home-quick-icon">
        <Icon name={props.icon} size={20} />
      </span>
      <span className="min-w-0 text-left">
        <span className="block text-base font-medium text-ink">{props.title}</span>
        <span className="block text-xs text-ink-subtle">{props.hint}</span>
      </span>
    </button>
  )
}
