import { LIBRARY_KINDS } from '@plein/nodes'
import type { CreateVoice, Voice } from '@plein/protocol'
import { createContext, type ReactNode, useContext, useLayoutEffect, useRef, useState } from 'react'
import { api, assetUrls } from '../../api/client'
import { useCatalog } from '../../stores/catalog'
import { confirmDialog, promptDialog } from '../../ui/Dialog'
import { EmptyState } from '../../ui/EmptyState'
import { Icon } from '../../ui/icons'
import { Modal, ModalHeader } from '../../ui/Modal'
import { ProviderIcon } from '../../ui/ProviderIcon'
import { Segmented } from '../../ui/Segmented'
import { Select } from '../../ui/Select'
import { KIND_ICONS } from './LibraryAdd'
import { type LibraryTab, useLibrary } from './store'
import { cacheVoice, dropVoice, useVoices, voiceTraits } from './voices'

type CloseRef = { current: () => void }
const CloseContext = createContext<CloseRef | null>(null)

/** 资产库弹窗外壳：Esc 和点遮罩时调用当前页签登记的关闭（上传中等情况页签可以拦住） */
export function LibraryModal({ children }: { children: ReactNode }) {
  const close = useRef(() => useLibrary.getState().show(null))
  return (
    <Modal
      label="资产库"
      onClose={() => close.current()}
      isolateKeys
      top
      className="lib-dialog h-[min(860px,100%)] max-w-6xl"
    >
      <CloseContext.Provider value={close}>{children}</CloseContext.Provider>
    </Modal>
  )
}

/** 页签登记自己的关闭逻辑 */
export function useLibraryClose(close: () => void) {
  const ref = useContext(CloseContext)
  useLayoutEffect(() => {
    if (ref) ref.current = close
  })
}

/** 资产库面板顶部的类别切换：各类资产卡，加上「音色」 */
export function LibraryTabs({ value, disabled }: { value: LibraryTab; disabled?: boolean }) {
  const show = useLibrary((s) => s.show)
  return (
    <fieldset disabled={disabled} className="contents">
      <div
        className="ui-scrollbar min-w-0 max-w-full overflow-x-auto"
        onFocusCapture={(event) => {
          if (event.target instanceof HTMLElement)
            event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }}
      >
        <Segmented<LibraryTab>
          label="资产类别"
          size="lg"
          options={[
            ...LIBRARY_KINDS.map((k) => ({ value: k.id, label: k.title, icon: KIND_ICONS[k.id] })),
            { value: 'voice' as const, label: '音色', icon: 'mic' as const },
          ]}
          value={value}
          onChange={show}
        />
      </div>
    </fieldset>
  )
}

const STATUS: Record<Voice['status'], { label: string; tone: string }> = {
  training: { label: '训练中', tone: 'ui-tag-warning' },
  ready: { label: '可用', tone: 'ui-tag-success' },
  failed: { label: '复刻失败', tone: 'ui-tag-danger' },
}

/**
 * 我的音色：上传一段样本在平台上复刻，或登记平台控制台里已有的音色。
 * 复刻出来的音色只能在同一家平台的配音模型里用，在角色卡和配音节点的音色下拉里选。
 */
export function VoicePanel() {
  const show = useLibrary((s) => s.show)
  const voices = useVoices()
  const [form, setForm] = useState<'clone' | 'register' | null>(null)
  const [busy, setBusy] = useState(false)
  const close = () => {
    if (!busy) show(null)
  }
  useLibraryClose(close)
  return (
    <>
      <ModalHeader
        title="资产库"
        onClose={close}
        closeDisabled={busy}
        meta={<LibraryTabs value="voice" disabled={busy} />}
      >
        {!form && (
          <>
            <button type="button" className="ui-btn" onClick={() => setForm('register')}>
              登记已有音色
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              onClick={() => setForm('clone')}
            >
              <Icon name="upload" />
              上传声音复刻
            </button>
          </>
        )}
      </ModalHeader>
      <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-5">
        {form ? (
          <VoiceForm mode={form} onBusy={setBusy} onDone={() => setForm(null)} />
        ) : voices.isError ? (
          <p role="alert" className="text-sm text-danger">
            音色列表读取失败：{(voices.error as Error).message}
            <button type="button" className="ui-btn ml-2" onClick={() => void voices.refetch()}>
              重试
            </button>
          </p>
        ) : !voices.data ? null : voices.data.length === 0 ? (
          <EmptyState
            fill
            icon="mic"
            title="还没有自己的音色"
            hint="上传一段清晰的人声样本，在配音平台上复刻成音色；也可以登记平台控制台里已有的音色。复刻出的音色会出现在角色卡和配音节点的音色下拉里。"
            action={
              <button
                type="button"
                className="ui-btn ui-btn-primary"
                onClick={() => setForm('clone')}
              >
                <Icon name="upload" />
                上传声音复刻
              </button>
            }
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {voices.data.map((v) => (
              <VoiceRow key={v.id} voice={v} />
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

function VoiceRow({ voice }: { voice: Voice }) {
  const catalog = useCatalog((s) => s.catalog)
  const provider = catalog?.providers.find((p) => p.id === voice.provider)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const status = STATUS[voice.status]
  const traits = voiceTraits(voice)
  const run = async (fn: () => Promise<void>) => {
    setPending(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(false)
    }
  }
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line px-4 py-3">
      <div className="flex min-w-48 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{voice.name}</span>
          <span className={`ui-tag ${status.tone}`}>{status.label}</span>
          {traits && <span className="ui-tag">{traits}</span>}
        </div>
        <div className="text-xs text-ink-subtle">
          {provider?.title ?? voice.provider} · <span className="font-mono">{voice.voiceId}</span>
          {!voice.sampleAssetId && ' · 登记的已有音色'}
        </div>
        {voice.message && (
          <p className={`text-xs ${voice.status === 'failed' ? 'text-danger' : 'text-ink-muted'}`}>
            {voice.message}
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
      {voice.sampleAssetId && (
        // oxlint-disable-next-line jsx-a11y/media-has-caption -- 用户上传的声音样本没有字幕轨
        <audio
          controls
          preload="none"
          aria-label={`${voice.name}的复刻样本`}
          src={assetUrls.original(voice.sampleAssetId)}
          className="h-8 max-w-64"
        />
      )}
      <div className="flex items-center gap-1">
        {voice.status === 'training' && (
          <button
            type="button"
            className="ui-btn"
            disabled={pending}
            onClick={() => void run(async () => cacheVoice(await api.refreshVoice(voice.id)))}
          >
            <Icon name="retry" />
            刷新状态
          </button>
        )}
        <button
          type="button"
          className="ui-btn ui-btn-quiet ui-icon-btn"
          aria-label={`重命名${voice.name}`}
          disabled={pending}
          onClick={() =>
            void run(async () => {
              const name = await promptDialog({
                title: '重命名音色',
                defaultValue: voice.name,
                maxLength: 40,
              })
              if (name) cacheVoice(await api.updateVoice(voice.id, { name }))
            })
          }
        >
          <Icon name="pencil" />
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-quiet ui-icon-btn hover:text-danger"
          aria-label={`删除${voice.name}`}
          disabled={pending}
          onClick={() =>
            void run(async () => {
              const ok = await confirmDialog({
                title: `删除音色「${voice.name}」？`,
                message:
                  '只从 Plein 里移除，平台上的音色不会删除；已经选了这个音色的角色卡和配音节点照常可用。',
                confirmLabel: '删除',
                danger: true,
              })
              if (!ok) return
              await api.deleteVoice(voice.id)
              dropVoice(voice.id)
            })
          }
        >
          <Icon name="trash" />
        </button>
      </div>
    </li>
  )
}

function VoiceForm({
  mode,
  onBusy,
  onDone,
}: {
  mode: 'clone' | 'register'
  onBusy(busy: boolean): void
  onDone(): void
}) {
  const catalog = useCatalog((s) => s.catalog)
  // 复刻只列支持复刻的已启用平台；登记列所有有配音模型的已启用平台
  const providers = (catalog?.providers ?? []).filter(
    (p) =>
      p.enabled &&
      (mode === 'clone'
        ? p.voiceClone
        : p.models.some((m) => m.capabilities.includes('audio.speech'))),
  )
  const [provider, setProvider] = useState(providers[0]?.id ?? '')
  const [name, setName] = useState('')
  const [voiceId, setVoiceId] = useState('')
  const [gender, setGender] = useState<CreateVoice['gender']>(null)
  const [age, setAge] = useState<CreateVoice['age']>(null)
  const [file, setFile] = useState<File | null>(null)
  const [pending, setPending] = useState<'upload' | 'clone' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const spec = providers.find((p) => p.id === provider)?.voiceClone
  const needsId = mode === 'register' || spec?.voiceId === 'slot'
  const ready =
    !!provider && !!name.trim() && (!needsId || !!voiceId.trim()) && (mode === 'register' || !!file)

  const submit = async () => {
    if (!ready || pending) return
    setError(null)
    onBusy(true)
    try {
      let sampleAssetId: string | null = null
      if (mode === 'clone' && file) {
        setPending('upload')
        sampleAssetId = (await api.upload(file)).id
      }
      setPending('clone')
      const voice = await api.createVoice({
        provider,
        name: name.trim(),
        voiceId: needsId ? voiceId.trim() : '',
        sampleAssetId,
        gender,
        age,
      })
      cacheVoice(voice)
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(null)
      onBusy(false)
    }
  }

  if (!providers.length)
    return (
      <EmptyState
        fill
        icon="plug"
        title={mode === 'clone' ? '没有可以复刻声音的平台' : '没有启用的配音平台'}
        hint={
          mode === 'clone'
            ? '在设置里启用豆包语音或 MiniMax 并填好密钥后，再回来上传样本。'
            : '在设置里启用一个配音平台后再登记音色。'
        }
        action={
          <button type="button" className="ui-btn" onClick={onDone}>
            返回
          </button>
        }
      />
    )

  return (
    <form
      className="mx-auto flex max-w-xl flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <h2 className="text-base font-medium">
        {mode === 'clone' ? '上传声音复刻' : '登记平台上已有的音色'}
      </h2>
      <div className="ui-field">
        <span className="ui-label">平台</span>
        <Select
          aria-label="平台"
          value={provider}
          options={providers.map((p) => ({
            value: p.id,
            label: p.title,
            icon: <ProviderIcon provider={p.id} />,
          }))}
          onChange={setProvider}
        />
        {mode === 'clone' && spec && <span className="ui-help">{spec.hint}</span>}
        {mode === 'register' && (
          <span className="ui-help">
            不调用平台、不计费；音色是否真的存在、能否用于当前配音模型，生成时才能确认。
          </span>
        )}
      </div>
      <label className="ui-field">
        <span className="ui-label">名称</span>
        <input
          className="ui-input"
          value={name}
          maxLength={40}
          placeholder="如：林夏、旁白男声"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {needsId && (
        <label className="ui-field">
          <span className="ui-label">音色 ID</span>
          <input
            className="ui-input font-mono"
            value={voiceId}
            placeholder={mode === 'clone' ? '控制台分配的 S_ 开头的 ID' : '平台上的音色 ID'}
            onChange={(e) => setVoiceId(e.target.value)}
          />
          {mode === 'clone' && (
            <span className="ui-help">同一个 ID 再上传一次会重新训练，覆盖原来的声音。</span>
          )}
        </label>
      )}
      <div className="flex gap-4">
        <div className="ui-field flex-1">
          <span className="ui-label">性别</span>
          <Select
            aria-label="性别"
            value={gender ?? ''}
            options={[
              { value: '', label: '不标注' },
              { value: 'female', label: '女' },
              { value: 'male', label: '男' },
            ]}
            onChange={(v) => setGender((v || null) as CreateVoice['gender'])}
          />
        </div>
        <div className="ui-field flex-1">
          <span className="ui-label">年龄感</span>
          <Select
            aria-label="年龄感"
            value={age ?? ''}
            options={[
              { value: '', label: '不标注' },
              { value: 'young', label: '青年' },
              { value: 'mature', label: '成熟' },
            ]}
            onChange={(v) => setAge((v || null) as CreateVoice['age'])}
          />
        </div>
      </div>
      {mode === 'clone' && (
        <div className="ui-field">
          <span className="ui-label">样本</span>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*"
            className="hidden"
            aria-label="选择样本音频"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <div className="flex items-center gap-3">
            <button type="button" className="ui-btn" onClick={() => fileRef.current?.click()}>
              <Icon name="audio" />
              {file ? '换一个文件' : '选择音频文件'}
            </button>
            {file && <span className="truncate text-sm text-ink-muted">{file.name}</span>}
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-danger/5 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="ui-btn" disabled={!!pending} onClick={onDone}>
          取消
        </button>
        <button type="submit" className="ui-btn ui-btn-primary" disabled={!ready || !!pending}>
          {pending === 'upload'
            ? '正在上传样本…'
            : pending === 'clone'
              ? mode === 'clone'
                ? '正在提交复刻…'
                : '正在登记…'
              : mode === 'clone'
                ? '开始复刻（会计费）'
                : '登记'}
        </button>
      </div>
    </form>
  )
}
