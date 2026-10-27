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
  failed: { label: '创建失败', tone: 'ui-tag-danger' },
}

/**
 * 我的音色：上传一段样本在平台上复刻，或登记平台控制台里已有的音色。
 * 复刻出来的音色只能在同一家平台的配音模型里用，在角色卡和配音节点的音色下拉里选。
 */
export function VoicePanel() {
  const show = useLibrary((s) => s.show)
  const voices = useVoices()
  const [form, setForm] = useState<'clone' | 'design' | 'register' | null>(null)
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
            <button type="button" className="ui-btn" onClick={() => setForm('design')}>
              音色设计
            </button>
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
        ) : !voices.data ? (
          <p role="status" className="text-sm text-ink-muted">
            正在读取音色…
          </p>
        ) : voices.data.length === 0 ? (
          <EmptyState
            fill
            icon="mic"
            title="还没有自己的音色"
            hint="用文字或角色图片设计新音色，上传人声样本复刻声音，或登记平台已有音色。复刻出的音色会出现在角色卡和配音节点的音色下拉里。"
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
  const status = voice.message?.startsWith('提交结果未知')
    ? { label: '待核查', tone: 'ui-tag-warning' }
    : STATUS[voice.status]
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
          {voice.source === 'design'
            ? ' · 设计音色'
            : !voice.sampleAssetId
              ? ' · 登记的已有音色'
              : ' · 复刻音色'}
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
      {(voice.previewAssetId || voice.sampleAssetId) && (
        // oxlint-disable-next-line jsx-a11y/media-has-caption -- 用户上传的声音样本没有字幕轨
        <audio
          controls
          preload="none"
          aria-label={`${voice.name}的${voice.previewAssetId ? '试听音频' : '复刻样本'}`}
          src={assetUrls.original((voice.previewAssetId || voice.sampleAssetId)!)}
          className="h-8 max-w-64"
        />
      )}
      <div className="flex items-center gap-1">
        {(voice.status === 'training' ||
          (voice.provider === 'doubao/speech' &&
            voice.source !== 'register' &&
            !voice.previewAssetId)) && (
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
  mode: 'clone' | 'design' | 'register'
  onBusy(busy: boolean): void
  onDone(): void
}) {
  const catalog = useCatalog((s) => s.catalog)
  const providers = (catalog?.providers ?? []).filter(
    (p) =>
      p.enabled &&
      (mode === 'clone'
        ? p.voiceClone
        : mode === 'design'
          ? p.voiceDesign
          : p.models.some((m) => m.capabilities.includes('audio.speech'))),
  )
  const [provider, setProvider] = useState(providers[0]?.id ?? '')
  const [name, setName] = useState('')
  const [voiceId, setVoiceId] = useState('')
  const [idMode, setIdMode] = useState<'slot' | 'custom'>('slot')
  const [gender, setGender] = useState<CreateVoice['gender']>(null)
  const [age, setAge] = useState<CreateVoice['age']>(null)
  const [file, setFile] = useState<File | null>(null)
  const [image, setImage] = useState<File | null>(null)
  const [promptFile, setPromptFile] = useState<File | null>(null)
  const [promptText, setPromptText] = useState('')
  const [prompt, setPrompt] = useState('')
  const [previewText, setPreviewText] = useState('')
  const [noiseReduction, setNoiseReduction] = useState(false)
  const [volumeNormalization, setVolumeNormalization] = useState(false)
  const [language, setLanguage] = useState<'zh' | 'en'>('zh')
  const [pending, setPending] = useState(false)
  const [stage, setStage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const selected = providers.find((p) => p.id === provider)
  const spec = mode === 'design' ? selected?.voiceDesign : selected?.voiceClone
  const design = selected?.voiceDesign
  const clone = selected?.voiceClone
  const needsId =
    mode === 'register' || (spec?.voiceId === 'slot' && (mode === 'design' || idMode === 'slot'))
  const ready =
    !!provider &&
    !!name.trim() &&
    (!needsId || !!voiceId.trim()) &&
    (mode === 'register' ||
      (mode === 'clone'
        ? !!file && !!promptFile === !!promptText.trim()
        : (!!prompt.trim() || !!image) && !!previewText.trim()))
  const submit = async () => {
    if (!ready || pending) return
    setError(null)
    setPending(true)
    onBusy(true)
    try {
      setStage('正在上传素材…')
      const upload = async (file: File | null) => (file ? (await api.upload(file)).id : null)
      const sampleAssetId = mode === 'clone' ? await upload(file) : null
      const imageAssetId = mode === 'design' && design?.image ? await upload(image) : null
      const promptSampleAssetId =
        mode === 'clone' && clone?.promptSample ? await upload(promptFile) : null
      setStage(
        mode === 'design' ? '正在设计音色…' : mode === 'clone' ? '正在复刻声音…' : '正在登记…',
      )
      const voice = await api.createVoice({
        mode,
        provider,
        name: name.trim(),
        voiceId: needsId || (mode === 'clone' && idMode === 'custom') ? voiceId.trim() : '',
        idMode,
        sampleAssetId,
        imageAssetId,
        promptSampleAssetId,
        prompt: mode === 'design' ? prompt.trim() : '',
        promptText: promptSampleAssetId ? promptText.trim() : '',
        previewText: mode === 'register' ? '' : previewText.trim(),
        noiseReduction,
        volumeNormalization,
        language,
        gender,
        age,
      })
      cacheVoice(voice)
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(false)
      onBusy(false)
    }
  }
  if (!providers.length)
    return (
      <EmptyState
        fill
        icon="plug"
        title="没有支持此操作的平台"
        hint="请在设置中启用并配置豆包语音或 MiniMax。"
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
        {mode === 'design'
          ? '音色设计'
          : mode === 'clone'
            ? '上传声音复刻'
            : '登记平台上已有的音色'}
      </h2>
      <fieldset disabled={pending} className="contents">
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
            onChange={(value) => {
              setProvider(value)
              setIdMode('slot')
              setVoiceId('')
              setImage(null)
              setPromptFile(null)
              setPromptText('')
              setError(null)
            }}
          />
          <span className="ui-help">
            {mode === 'register' ? '仅登记，不调用平台；可用性在正式生成时确认。' : spec?.hint}
          </span>
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
        {mode === 'clone' && clone?.customId && (
          <div className="ui-field">
            <span className="ui-label">音色类型</span>
            <Select
              aria-label="音色类型"
              value={idMode}
              options={[
                { value: 'slot', label: '预付费音色槽位' },
                { value: 'custom', label: '后付费自定义音色' },
              ]}
              onChange={(v) => {
                setIdMode(v as 'slot' | 'custom')
                setVoiceId('')
              }}
            />
          </div>
        )}
        {(needsId || (mode === 'clone' && idMode === 'custom')) && (
          <label className="ui-field">
            <span className="ui-label">音色 ID{!needsId && '（可选）'}</span>
            <input
              className="ui-input font-mono"
              aria-label={needsId ? '音色 ID' : '音色 ID（可选）'}
              maxLength={256}
              value={voiceId}
              placeholder={
                idMode === 'custom'
                  ? '留空自动生成；8–256 位，字母开头'
                  : mode === 'register'
                    ? '平台上的音色 ID'
                    : '控制台分配的 S_ 音色槽位 ID'
              }
              onChange={(e) => setVoiceId(e.target.value)}
            />
            {needsId && mode !== 'register' && (
              <span className="ui-help">再次使用同一槽位会覆盖原音色并消耗次数。</span>
            )}
          </label>
        )}
        {mode !== 'register' && provider === 'doubao/speech' && (
          <div className="ui-field">
            <span className="ui-label">语种</span>
            <Select
              aria-label="语种"
              value={language}
              options={[
                { value: 'zh', label: '中文' },
                { value: 'en', label: '英文' },
              ]}
              onChange={(v) => setLanguage(v as 'zh' | 'en')}
            />
          </div>
        )}
        {mode === 'design' && (
          <>
            <label className="ui-field">
              <span className="ui-label">音色描述</span>
              <textarea
                className="ui-input"
                rows={3}
                maxLength={design?.maxPromptLength}
                value={prompt}
                placeholder="描述年龄、声线、口音、语气与人物气质"
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>
            {design?.image && (
              <VoiceFile
                label="角色图片（可选）"
                accept="image/jpeg,image/png,image/webp"
                file={image}
                onChange={setImage}
                hint="10 MB 以内；提供图片时，平台优先根据图片设计音色。"
              />
            )}
          </>
        )}
        {mode === 'clone' && (
          <>
            <VoiceFile label="样本音频" accept="audio/*" file={file} onChange={setFile} />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={noiseReduction}
                onChange={(e) => setNoiseReduction(e.target.checked)}
              />
              降噪<span className="ui-help">可能改变声音细节，干净样本建议关闭</span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={volumeNormalization}
                onChange={(e) => setVolumeNormalization(e.target.checked)}
              />
              音量归一化
            </label>
            {clone?.promptSample && (
              <details className="ui-field">
                <summary className="cursor-pointer text-sm">增强参考（可选）</summary>
                <VoiceFile
                  label="增强参考音频"
                  accept="audio/*"
                  file={promptFile}
                  onChange={setPromptFile}
                  hint="小于 8 秒、20 MB 以内，与主复刻样本不同；须填写对应文字。"
                />
                <label className="ui-field">
                  <span className="ui-label">增强参考对应文字</span>
                  <textarea
                    className="ui-input"
                    value={promptText}
                    maxLength={1000}
                    onChange={(e) => setPromptText(e.target.value)}
                  />
                </label>
              </details>
            )}
          </>
        )}
        {mode !== 'register' && (
          <label className="ui-field">
            <span className="ui-label">试听文本{mode === 'clone' && '（可选）'}</span>
            <textarea
              className="ui-input"
              rows={2}
              aria-label="试听文本"
              maxLength={
                mode === 'design'
                  ? design?.maxPreviewLength
                  : provider === 'doubao/speech'
                    ? 300
                    : 1000
              }
              value={previewText}
              placeholder="输入用新音色朗读的内容"
              onChange={(e) => setPreviewText(e.target.value)}
            />
            <span className="ui-help">
              试听合成可能计费；文本请与所选语种一致。
              {mode === 'clone' && provider === 'doubao/speech' && '填写时须为 4–300 字。'}
            </span>
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
      </fieldset>
      {error && (
        <p role="alert" className="rounded-lg bg-danger/5 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="ui-btn" disabled={pending} onClick={onDone}>
          取消
        </button>
        <button type="submit" className="ui-btn ui-btn-primary" disabled={!ready || pending}>
          {pending
            ? stage
            : mode === 'design'
              ? '设计音色'
              : mode === 'clone'
                ? '开始复刻'
                : '登记音色'}
        </button>
      </div>
    </form>
  )
}

function VoiceFile({
  label,
  accept,
  file,
  onChange,
  hint,
}: {
  label: string
  accept: string
  file: File | null
  onChange(file: File | null): void
  hint?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div className="ui-field">
      <span className="ui-label">{label}</span>
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        aria-label={`选择${label}`}
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      />
      <div className="flex items-center gap-3">
        <button type="button" className="ui-btn" onClick={() => ref.current?.click()}>
          {file ? '更换' : '选择'}
          {label}
        </button>
        {file && (
          <>
            <span className="truncate text-sm text-ink-muted">{file.name}</span>
            <button
              type="button"
              className="ui-btn"
              onClick={() => {
                onChange(null)
                if (ref.current) ref.current.value = ''
              }}
            >
              移除
            </button>
          </>
        )}
      </div>
      {hint && <span className="ui-help">{hint}</span>}
    </div>
  )
}
