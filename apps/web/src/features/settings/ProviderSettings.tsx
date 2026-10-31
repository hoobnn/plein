import { capabilityLabel } from '@plein/nodes'
import type { Capability } from '@plein/plugin-sdk'
import type { Catalog, ProviderConfigView, ProviderInfo, ProviderTestResult } from '@plein/protocol'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { Icon } from '../../ui/icons'
import { ProviderIcon } from '../../ui/ProviderIcon'
import { Select } from '../../ui/Select'
import { type ObjectSchema, SchemaForm } from '../../ui/SchemaForm'
import { Switch } from '../../ui/Switch'
import { confirmDialog, choiceDialog } from '../../ui/Dialog'
import { Group } from './SettingsGroup'
import { ProviderCredentials } from './ProviderCredentials'
import { removalImpact } from './credentialUsage'
import {
  credentialCardDirty,
  credentialLabelChanged,
  providerDirty,
  sameSettings,
  type CredentialCardDraft,
} from './providerDirty'
import { credentialUsed, replaceWarning } from './credentialUsage'

/** 平台卡片的状态只表示本地配置与最近一次校验，不把填写密钥标成远端可用。多组时顺带显示当前组。 */
function providerState(
  p: ProviderInfo,
  check: { testing: boolean; failed: boolean },
): { label: string; tone: string } {
  if (!p.enabled) return { label: '已停用', tone: '' }
  if (!p.configured) return { label: '未配置', tone: 'ui-tag-warning' }
  if (check.failed) return { label: '校验失败', tone: 'ui-tag-danger' }
  if (check.testing) return { label: '校验中', tone: '' }
  // 目录在多组时带当前组标签；保存、删除、设为使用后 onSaved 会刷新目录
  return p.activeCredentialLabel
    ? { label: `已连接 · ${p.activeCredentialLabel}`, tone: 'ui-tag-success' }
    : { label: '已连接', tone: 'ui-tag-success' }
}

/** 单个平台：一张卡片（彩色图标、状态、启用开关、主操作），展开后是设置表单（由插件声明的 schema 生成）、密钥、校验 */
export function ProviderRow({
  provider,
  open,
  onToggleOpen,
  onSaved,
  enableOnSave = false,
  disabled = false,
  active = true,
}: {
  provider: ProviderInfo
  open: boolean
  onToggleOpen(): void
  onSaved(): void | Promise<void>
  /** 保存时顺带启用（首次启动引导里填完密钥就能用） */
  enableOnSave?: boolean
  disabled?: boolean
  active?: boolean
}) {
  const [config, setConfig] = useState<ProviderConfigView | null>(null)
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  // 已保存组的草稿（键为组 id）：标签留空表示不修改，密钥留空表示不修改
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [groupSecrets, setGroupSecrets] = useState<Record<string, Record<string, string>>>({})
  // 没保存过的新卡；新平台没有任何组时预填一张「默认」
  const [drafts, setDrafts] = useState<CredentialCardDraft[]>([])
  const nextDraft = useRef(0)
  // 替换改成新组后要聚焦的草稿卡：渲染完成后把焦点交给它的标签输入
  const focusDraft = useRef<string | null>(null)
  const [status, setStatus] = useState<{ message: string; error?: boolean } | null>(null)
  const [test, setTest] = useState<ProviderTestResult | null>(null)
  const [busy, setBusy] = useState(false)
  // 正在跑校验：卡片状态显示「校验中」，结束后按结果变成「校验失败」或「已连接」
  const [testing, setTesting] = useState(false)
  // 保存成功后递增：密钥卡收起就地输入、复位明文状态
  const [credentialReset, setCredentialReset] = useState(0)
  const locked = busy || disabled
  const [configError, setConfigError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [numberEditing, setNumberEditing] = useState(false)
  const formFields = useRef<HTMLFieldSetElement>(null)
  const closedFeedback = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (active && !open && (busy || status?.error))
      closedFeedback.current?.scrollIntoView({ block: 'nearest' })
  }, [active, open, busy, status])
  const clearFeedback = () => {
    setStatus(null)
    setTest(null)
  }

  // 展开时才读配置
  useEffect(() => {
    if (!active || !open || config) return
    let cancelled = false
    setConfigError(null)
    api.providerConfig(provider.id).then(
      (c) => {
        if (cancelled) return
        setConfig(c)
        setSettings(c.settings)
      },
      (err) => {
        if (!cancelled) setConfigError(`读取配置失败：${(err as Error).message}`)
      },
    )
    return () => {
      cancelled = true
    }
  }, [active, open, config, provider.id, loadAttempt])

  // 新平台还没有任何组：预填一张「默认」卡，填完保存即创建第一组（服务端自动设为使用）
  useEffect(() => {
    if (!config || provider.secrets.length === 0 || (config.credentials?.length ?? 0) > 0) return
    setDrafts((current) => (current.length ? current : [seedDraft()]))
  }, [config, provider.secrets.length])

  const isSavedGroup = (key: string) => config?.credentials?.some((c) => c.id === key) ?? false

  /** 确认前重新读取配置：usage 随任务与音色变化，缓存可能是展开时的旧值；失败退回缓存值不阻断 */
  const refreshConfig = async (): Promise<ProviderConfigView | null> => {
    try {
      const next = await api.providerConfig(provider.id)
      // 只换服务端视图，不动 labels / groupSecrets / drafts：用户正在编辑的草稿保留
      setConfig(next)
      return next
    } catch {
      return null
    }
  }

  // 聚焦刚移入的草稿卡标签：卡片列表渲染完成后执行一次
  useEffect(() => {
    if (!focusDraft.current) return
    const input = formFields.current?.querySelector<HTMLInputElement>(
      `[data-credential="${focusDraft.current}"] input[type="text"]`,
    )
    if (input) {
      focusDraft.current = null
      input.focus()
    }
  })

  /** 新平台的预填卡：固定的临时键，同一时刻最多存在一张 */
  const seedDraft = (): CredentialCardDraft => ({
    key: 'draft-seed',
    label: '默认',
    secrets: {},
    baseline: '默认',
  })

  // 已保存组的卡：基线是已保存的标签，留空表示不修改
  const savedCards: CredentialCardDraft[] = (config?.credentials ?? []).map((c) => ({
    key: c.id,
    label: labels[c.id] ?? '',
    secrets: groupSecrets[c.id] ?? {},
    baseline: c.label,
  }))
  // 设置或数字没保存时，密钥卡的检查连接也得等：检查的是设置加密钥的整体配置
  const settingsDirty = numberEditing || !sameSettings(settings, config?.settings)

  const setCardLabel = (key: string, value: string) => {
    clearFeedback()
    if (isSavedGroup(key)) setLabels({ ...labels, [key]: value })
    else setDrafts(drafts.map((d) => (d.key === key ? { ...d, label: value } : d)))
  }

  const setCardSecret = (key: string, name: string, value: string) => {
    clearFeedback()
    if (isSavedGroup(key))
      setGroupSecrets({ ...groupSecrets, [key]: { ...groupSecrets[key], [name]: value } })
    else
      setDrafts(
        drafts.map((d) => (d.key === key ? { ...d, secrets: { ...d.secrets, [name]: value } } : d)),
      )
  }

  const addDraft = () => {
    clearFeedback()
    setDrafts([...drafts, { key: `draft-${nextDraft.current++}`, label: '', secrets: {} }])
  }

  const discardDraft = (key: string) => {
    clearFeedback()
    setDrafts((current) => {
      const rest = current.filter((d) => d.key !== key)
      // 移除后一个组都不剩：重新给出预填卡，保留新平台创建第一组的入口
      return rest.length || (config?.credentials?.length ?? 0) > 0 ? rest : [seedDraft()]
    })
  }

  /** 非空输入；已保存组留空表示不修改，不进请求 */
  const typedSecrets = (values: Record<string, string> = {}) =>
    Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''))

  /** 把已保存卡里刚输入的密钥移到新草稿卡（标签留空），原组保持不变：密钥输入清空，刚改的标签也退回 */
  const moveToDraft = (cards: CredentialCardDraft[]) => {
    const moved: CredentialCardDraft[] = []
    let secrets = groupSecrets
    let nextLabels = labels
    for (const card of cards) {
      const typed = typedSecrets(card.secrets)
      if (Object.keys(typed).length === 0) continue
      moved.push({ key: `draft-${nextDraft.current++}`, label: '', secrets: typed })
      secrets = { ...secrets, [card.key]: {} }
      nextLabels = { ...nextLabels, [card.key]: '' }
    }
    if (moved.length === 0) return
    focusDraft.current = moved[0]!.key
    setGroupSecrets(secrets)
    setLabels(nextLabels)
    setDrafts([...drafts, ...moved])
    // 原组的密钥输入已清空：卡片收起回掩码，刚输入的密钥只留在新草稿卡里
    setCredentialReset((token) => token + 1)
  }

  /** 保存成功返回 true：未配置平台的主操作要在保存后接着校验 */
  const save = async (): Promise<boolean> => {
    // 必填标签或数字没填好时先聚焦问题输入，不发出请求
    const invalid = formFields.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
    if (invalid) {
      invalid.focus()
      return false
    }
    // 只提交改过的标签与非空密钥，与脏检查共用同一判断；新卡作为 credentials.add 创建（改动过的预填卡也算）
    const update = savedCards.flatMap((card) => {
      const labelChanged = credentialLabelChanged(card)
      const secrets = typedSecrets(card.secrets)
      return labelChanged || Object.keys(secrets).length
        ? [
            {
              id: card.key,
              ...(labelChanged ? { label: card.label.trim() } : {}),
              ...(Object.keys(secrets).length ? { secrets } : {}),
            },
          ]
        : []
    })
    const add = drafts
      .filter((d) => d.baseline === undefined || credentialCardDirty(d))
      .map((d) => ({ label: d.label.trim(), secrets: typedSecrets(d.secrets) }))
    // 已保存组填了新密钥且名下还有任务或音色：替换前先确认；usage 取最新，缓存可能是展开时的旧值
    const view = (await refreshConfig()) ?? config
    const replacing = savedCards.filter(
      (card) =>
        Object.values(card.secrets).some((v) => v !== '') &&
        credentialUsed(
          view?.credentials?.find((c) => c.id === card.key)?.usage ?? { tasks: 0, voices: 0 },
        ),
    )
    if (replacing.length > 0) {
      const groups = replacing.map((card) => {
        const saved = view?.credentials?.find((c) => c.id === card.key)
        return { label: saved?.label ?? card.key, usage: saved?.usage ?? { tasks: 0, voices: 0 } }
      })
      const choice = await choiceDialog({
        title: '替换仍在使用的密钥？',
        message: replaceWarning(groups),
        confirmLabel: '仍然替换',
        alternateLabel: '改为添加新组',
        initialFocus: 'alternate',
      })
      if (!choice) return false
      // 改为添加新组：刚输入的密钥移到新草稿卡，原组保持不变，本次不保存
      if (choice === 'alternate') {
        clearFeedback()
        moveToDraft(replacing)
        return false
      }
    }
    setBusy(true)
    clearFeedback()
    try {
      // settings 与已保存一致时不带：服务端整体替换，带上旧值会把别的窗口刚保存的设置冲掉
      const settingsChanged = !sameSettings(settings, config?.settings)
      const next = await api.updateProviderConfig(provider.id, {
        ...(enableOnSave ? { enabled: true } : {}),
        ...(settingsChanged ? { settings } : {}),
        ...(update.length || add.length
          ? {
              credentials: {
                ...(update.length ? { update } : {}),
                ...(add.length ? { add } : {}),
              },
            }
          : {}),
      })
      setConfig(next)
      setLabels({})
      setGroupSecrets({})
      setDrafts([])
      setCredentialReset((token) => token + 1)
      setNumberEditing(false)
      setStatus({ message: '已保存' })
      await onSaved()
      return true
    } catch (err) {
      setStatus({ message: `保存失败：${(err as Error).message}`, error: true })
      return false
    } finally {
      setBusy(false)
    }
  }

  const setEnabled = async (enabled: boolean) => {
    setBusy(true)
    clearFeedback()
    try {
      const next = await api.updateProviderConfig(provider.id, { enabled })
      if (config) setConfig(next)
      await onSaved()
    } catch (err) {
      setStatus({ message: `保存失败：${(err as Error).message}`, error: true })
    } finally {
      setBusy(false)
    }
  }

  /** 设为使用是即时操作：单独保存 activeCredential，不牵动其他草稿 */
  const useCredential = async (key: string) => {
    setBusy(true)
    clearFeedback()
    try {
      setConfig(await api.updateProviderConfig(provider.id, { activeCredential: key }))
      await onSaved()
    } catch (err) {
      setStatus({ message: `保存失败：${(err as Error).message}`, error: true })
    } finally {
      setBusy(false)
    }
  }

  /** 删除已保存的组也是即时操作；删当前组时服务端会改用剩下的第一组 */
  const removeCredential = async (key: string) => {
    if (!config) return
    // 确认文案用最新 usage：缓存可能是展开时的旧值，新产生的任务与音色也算
    const view = (await refreshConfig()) ?? config
    const groups = view.credentials ?? []
    const target = groups.find((c) => c.id === key)
    if (!target) return
    const rest = groups.filter((c) => c.id !== key)
    const switching = view.activeCredential === key && rest.length > 0
    // 名下还有未取回的结果或音色时先说清后果；正在使用的组顺带说明会切到哪一组
    const notes = [
      removalImpact(target.usage),
      switching ? `这一组正在使用，删除后会改用「${rest[0]!.label}」的密钥。` : '',
    ].filter(Boolean)
    const ok = await confirmDialog({
      title: `删除密钥组「${target.label}」？`,
      message: notes.length > 0 ? notes.join('') : undefined,
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    clearFeedback()
    try {
      setConfig(await api.updateProviderConfig(provider.id, { credentials: { remove: [key] } }))
      const keep = <T,>(current: Record<string, T>) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => id !== key)) as Record<
          string,
          T
        >
      setLabels((current) => keep(current))
      setGroupSecrets((current) => keep(current))
      await onSaved()
    } catch (err) {
      setStatus({ message: `保存失败：${(err as Error).message}`, error: true })
    } finally {
      setBusy(false)
    }
  }

  /** 卡片上的检查连接指定用哪一组密钥 */
  const testCard = async (key: string) => {
    clearFeedback()
    setBusy(true)
    setTesting(true)
    try {
      setTest(await api.testProvider(provider.id, key))
    } catch (err) {
      // 传输失败没有服务端检查结果，不能伪造 scope 或完成时间。
      setStatus({ error: true, message: `检查请求失败：${(err as Error).message}` })
    } finally {
      setTesting(false)
      setBusy(false)
    }
  }

  const runTest = async () => {
    clearFeedback()
    setBusy(true)
    setTesting(true)
    try {
      setTest(await api.testProvider(provider.id))
    } catch (err) {
      // 传输失败没有服务端检查结果，不能伪造 scope 或完成时间。
      setStatus({ error: true, message: `检查请求失败：${(err as Error).message}` })
    } finally {
      setTesting(false)
      setBusy(false)
    }
  }

  /** 未配置平台的主操作：保存后立刻校验，结果就地显示 */
  const saveAndTest = async () => {
    if (await save()) await runTest()
  }

  const state = providerState(provider, { testing, failed: test ? !test.ok : false })
  const bodyId = `provider-${provider.id}`
  const dirty = providerDirty(settings, config?.settings, [...savedCards, ...drafts], numberEditing)
  const feedback = test
    ? {
        message: test.ok
          ? (test.message ?? '检查完成；尚未验证具体模型、资源权限或余额')
          : `检查失败：${test.message ?? '未知错误'}`,
        error: !test.ok,
      }
    : status

  return (
    <li
      className="flex flex-col rounded-xl bg-surface p-3.5 ring-1 ring-line"
      data-provider={provider.id}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggleOpen}
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
        >
          <ProviderIcon provider={provider.id} size={28} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-medium break-words">{provider.title}</span>
              <span className={`ui-tag ${state.tone}`} title="本地配置状态不代表具体模型权限或余额">
                {state.label}
              </span>
            </span>
            <span className="mt-0.5 block text-xs text-ink-subtle" title={provider.description}>
              {provider.description ?? `${provider.models.length} 个模型`}
            </span>
          </span>
          {/* 右侧主操作跟着标题一起可点：未配置先给配置入口，配置好后改成管理 */}
          <span
            aria-hidden="true"
            className={`ui-btn ui-btn-xs flex-none ${open ? 'ui-btn-quiet' : 'ui-btn-secondary'}`}
          >
            {open ? '收起' : provider.configured ? '管理' : '配置密钥'}
          </span>
          <span
            className={`mt-0.5 flex-none text-ink-subtle transition-transform ${open ? 'rotate-90' : ''}`}
          >
            <Icon name="chevronRight" size={14} />
          </span>
        </button>
        <Switch
          checked={provider.enabled}
          disabled={locked}
          label={`启用 ${provider.title}`}
          onChange={setEnabled}
        />
      </div>
      {!open && (busy || status?.error) && (
        <p
          ref={closedFeedback}
          className={`mt-2 text-xs ${busy ? 'text-ink-muted' : 'text-danger'}`}
          role={busy ? 'status' : 'alert'}
        >
          {busy ? '处理中…' : status?.message}
        </p>
      )}
      <div hidden={!open}>
        <div id={bodyId} className="flex min-w-0 flex-col gap-4 pt-4">
          {provider.models.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {provider.models.map((m) => (
                <span key={m.id} className="ui-tag">
                  {m.title}
                </span>
              ))}
            </div>
          )}
          {!config ? (
            <div className="flex flex-col gap-2">
              <p
                className={configError ? 'text-xs text-danger' : 'text-xs text-ink-subtle'}
                role={configError ? 'alert' : 'status'}
              >
                {configError ?? '读取中…'}
              </p>
              {configError && (
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary self-start"
                  onClick={() => setLoadAttempt((attempt) => attempt + 1)}
                >
                  重试读取配置
                </button>
              )}
            </div>
          ) : (
            <>
              <fieldset
                ref={formFields}
                disabled={locked}
                className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0"
              >
                <ProviderCredentials
                  provider={provider}
                  config={config}
                  labels={labels}
                  groupSecrets={groupSecrets}
                  drafts={drafts}
                  settingsDirty={settingsDirty}
                  onLabel={setCardLabel}
                  onSecret={setCardSecret}
                  onUse={(key) => void useCredential(key)}
                  onRemove={(key) => void removeCredential(key)}
                  onDiscard={discardDraft}
                  onTest={(key) => void testCard(key)}
                  onAdd={addDraft}
                  onSubmit={() => void (provider.configured ? save() : saveAndTest())}
                  resetToken={credentialReset}
                />
                <SchemaForm
                  schema={provider.settingsSchema as ObjectSchema}
                  value={settings}
                  onNumberEdit={() => {
                    clearFeedback()
                    setNumberEditing(true)
                  }}
                  onNumberEditEnd={() => {
                    // 数字输入不合法、草稿已退回原值：这里没有未保存的改动，
                    // 要把「正在编辑」收尾，否则检查按钮会被永久禁用。
                    setNumberEditing(false)
                  }}
                  onChange={(next) => {
                    clearFeedback()
                    setNumberEditing(false)
                    setSettings(next)
                  }}
                />
              </fieldset>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`mr-auto text-xs ${feedback?.error ? 'text-danger' : 'text-ink-muted'}`}
                  role={feedback?.error ? 'alert' : 'status'}
                >
                  {busy ? '处理中…' : feedback?.message}
                </span>
                <button
                  type="button"
                  disabled={locked || dirty}
                  aria-describedby={dirty ? `${bodyId}-unsaved` : undefined}
                  onClick={runTest}
                  className="ui-btn ui-btn-secondary"
                >
                  {provider.testScope === 'configuration' ? '检查配置' : '测试连接'}
                </button>
                {!provider.configured && (
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => save()}
                    className="ui-btn ui-btn-secondary"
                  >
                    保存
                  </button>
                )}
                <button
                  type="button"
                  disabled={locked}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return
                    const input = formFields.current?.querySelector<HTMLInputElement>(
                      'input[type="number"]:focus',
                    )
                    if (input?.validity.badInput) {
                      event.preventDefault()
                      input.blur()
                      input.focus()
                    }
                  }}
                  onClick={() => void (provider.configured ? save() : saveAndTest())}
                  className="ui-btn ui-btn-primary"
                >
                  {provider.configured ? '保存' : '保存并校验'}
                </button>
              </div>
              {dirty && (
                <p id={`${bodyId}-unsaved`} className="text-xs text-ink-muted">
                  修改尚未保存，请先保存再
                  {provider.testScope === 'configuration' ? '检查配置' : '测试连接'}。
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </li>
  )
}

/** 平台目录的读取与恢复区域，保留最后读取的数据和未保存表单。 */
export function ProviderSettings({
  catalog,
  catalogError,
  load,
  openProvider,
  onToggleOpen,
  active = true,
}: {
  catalog: Catalog | null
  catalogError: string | null
  load(): Promise<void>
  openProvider: string | null
  onToggleOpen(id: string): void
  active?: boolean
}) {
  const [updatingCatalog, setUpdatingCatalog] = useState(false)
  const catalogFeedback = useRef<HTMLDivElement>(null)
  const providersBlocked = !!catalogError || updatingCatalog
  useEffect(() => {
    if (active && catalogError) catalogFeedback.current?.scrollIntoView({ block: 'nearest' })
  }, [active, catalogError])
  const retryCatalog = async () => {
    setUpdatingCatalog(true)
    try {
      await load()
    } finally {
      setUpdatingCatalog(false)
    }
  }
  const connected = (catalog?.providers ?? []).filter((p) => p.enabled && p.configured).length
  return (
    <div className="flex flex-col gap-8">
      {catalogError && (
        <div ref={catalogFeedback} className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-danger">
            平台目录更新失败：{catalogError}
          </p>
          {catalog && (
            <p className="text-xs text-ink-muted">当前显示上次读取的目录；已完成的保存无需重复。</p>
          )}
          <button
            type="button"
            className="ui-btn ui-btn-secondary self-start"
            disabled={updatingCatalog}
            onClick={() => void retryCatalog()}
          >
            {updatingCatalog ? '正在更新平台目录…' : '重试更新平台目录'}
          </button>
        </div>
      )}
      {!catalog && !catalogError && (
        <p role="status" className="text-sm text-ink-subtle">
          读取模型平台…
        </p>
      )}
      {catalog && (
        <Group title="默认模型" hint="新建节点时写进节点的模型；已有的节点不受影响，节点上可以另选">
          <DefaultModels catalog={catalog} onSaved={load} disabled={providersBlocked} />
        </Group>
      )}
      {catalog && (
        <Group title="已安装的平台" hint="启用并填好密钥后，节点里才能选到这个平台的模型">
          {catalog.providers.length === 0 ? (
            <p className="text-sm text-ink-subtle">还没有安装模型平台插件。</p>
          ) : (
            <>
              <p className="text-xs text-ink-subtle">
                已连接 {connected} / 共 {catalog.providers.length} 个平台
              </p>
              <ul aria-label="平台" className="flex flex-col gap-2">
                {[...catalog.providers]
                  .sort((a, b) => Number(b.configured) - Number(a.configured))
                  .map((p) => (
                    <ProviderRow
                      key={p.id}
                      provider={p}
                      open={openProvider === p.id}
                      onToggleOpen={() => onToggleOpen(p.id)}
                      onSaved={load}
                      disabled={providersBlocked}
                      active={active}
                    />
                  ))}
              </ul>
            </>
          )}
        </Group>
      )}
    </div>
  )
}

/** 默认模型：每种能力一项，只列已启用且填好密钥的平台的模型 */
function DefaultModels({
  catalog,
  onSaved,
  disabled = false,
}: {
  catalog: Catalog
  onSaved(): void | Promise<void>
  disabled?: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(new Set<Capability>())
  const [saving, setSaving] = useState<Capability[]>([])
  const ready = catalog.providers.filter((p) => p.enabled && p.configured)
  const rows = CAPABILITY_ORDER.map((cap) => ({
    cap,
    options: ready.flatMap((p) =>
      p.models
        .filter((m) => !m.deprecated && m.capabilities.includes(cap))
        .map((m) => ({
          value: `${p.id}:${m.id}`,
          label: `${p.title} · ${m.title ?? m.id}`,
          icon: <ProviderIcon provider={p.id} />,
        })),
    ),
  })).filter((r) => r.options.length > 0)
  if (rows.length === 0)
    return <p className="text-sm text-ink-subtle">先在下面启用平台并填好密钥。</p>
  const save = async (capability: Capability, model: string) => {
    if (disabled || inFlight.current.has(capability)) return
    inFlight.current.add(capability)
    setSaving([...inFlight.current])
    setError(null)
    try {
      await api.setDefaultModel({ capability, model })
      await onSaved()
    } catch (err) {
      setError(`保存失败：${(err as Error).message}`)
    } finally {
      inFlight.current.delete(capability)
      setSaving([...inFlight.current])
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <ul className="rounded-lg ring-1 ring-line">
        {rows.map((r) => (
          <li
            key={r.cap}
            className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
          >
            <span className="w-20 flex-none text-sm">{capabilityLabel(r.cap)}</span>
            <Select
              disabled={disabled || saving.includes(r.cap)}
              aria-label={`默认${capabilityLabel(r.cap)}模型`}
              value={catalog.defaultModels[r.cap] ?? ''}
              options={r.options}
              onChange={(v) => void save(r.cap, v)}
              className="min-w-0 flex-1"
            />
          </li>
        ))}
      </ul>
      {saving.map((capability) => (
        <p key={capability} role="status" className="text-xs text-ink-muted">
          正在保存{capabilityLabel(capability)}默认模型…
        </p>
      ))}
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** 默认模型的列出顺序 */
const CAPABILITY_ORDER: Capability[] = [
  'text.chat',
  'image.generate',
  'image.edit',
  'video.generate',
  'audio.speech',
  'audio.music',
  'audio.sfx',
  'audio.transcribe',
]
