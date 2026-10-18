import { capabilityLabel } from '@plein/nodes'
import type { Capability } from '@plein/plugin-sdk'
import type { Catalog, ProviderConfigView, ProviderInfo, ProviderTestResult } from '@plein/protocol'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { Icon } from '../../ui/icons'
import { Select } from '../../ui/Select'
import { type ObjectSchema, SchemaForm } from '../../ui/SchemaForm'
import { Switch } from '../../ui/Switch'
import { Group } from './SettingsGroup'

const input = 'ui-input ui-input-lg w-full'

/** 平台行的状态：停用 / 缺密钥 / 可用 */
function providerState(p: ProviderInfo): { label: string; tone: string } {
  if (!p.enabled) return { label: '已停用', tone: '' }
  if (!p.configured) return { label: '缺少密钥', tone: 'ui-tag-warning' }
  return { label: '已配置', tone: 'ui-tag-success' }
}

/** 单个平台：一行摘要（状态、启用开关），展开后是设置表单（由插件声明的 schema 生成）、密钥、测试连接 */
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
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<{ message: string; error?: boolean } | null>(null)
  const [test, setTest] = useState<ProviderTestResult | null>(null)
  const [busy, setBusy] = useState(false)
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

  const save = async () => {
    const invalid = formFields.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
    if (invalid) {
      invalid.focus()
      return
    }
    setBusy(true)
    clearFeedback()
    try {
      const next = await api.updateProviderConfig(provider.id, {
        ...(enableOnSave ? { enabled: true } : {}),
        settings,
        // 只提交改过的密钥；留空表示不修改
        secrets: Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== '')),
      })
      setConfig(next)
      setSecrets({})
      setNumberEditing(false)
      setStatus({ message: '已保存' })
      await onSaved()
    } catch (err) {
      setStatus({ message: `保存失败：${(err as Error).message}`, error: true })
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

  const runTest = async () => {
    clearFeedback()
    setBusy(true)
    try {
      setTest(await api.testProvider(provider.id))
    } catch (err) {
      setTest({ ok: false, message: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const state = providerState(provider)
  const bodyId = `provider-${provider.id}`
  const dirty =
    numberEditing ||
    (!!config &&
      (Object.values(secrets).some((value) => value !== '') ||
        JSON.stringify(settings) !== JSON.stringify(config.settings)))
  const feedback = test
    ? {
        message: test.ok ? (test.message ?? '连接正常') : `检查失败：${test.message ?? '未知错误'}`,
        error: !test.ok,
      }
    : status

  return (
    <li className="border-b border-line last:border-b-0" data-provider={provider.id}>
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggleOpen}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span
            className={`flex-none text-ink-subtle transition-transform ${open ? 'rotate-90' : ''}`}
          >
            <Icon name="chevronRight" size={14} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{provider.title}</span>
            <span className="block truncate text-xs text-ink-subtle">
              {provider.description ?? `${provider.models.length} 个模型`}
            </span>
          </span>
          <span className={`ui-tag ${state.tone}`}>{state.label}</span>
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
          className={`px-4 pb-3 text-xs ${busy ? 'text-ink-muted' : 'text-danger'}`}
          role={busy ? 'status' : 'alert'}
        >
          {busy ? '处理中…' : status?.message}
        </p>
      )}
      {/* 展开的内容和标题文字对齐：左边距 16 + 箭头 14 + 间距 12 */}
      <div hidden={!open}>
        <div id={bodyId} className="flex flex-col gap-4 px-4 pb-4 pl-10.5">
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
                {provider.secrets.map((s) => (
                  <label key={s.name} className="ui-field">
                    <span className="ui-label">
                      {s.title}
                      {s.required ? '' : '（可选）'}
                    </span>
                    <input
                      type="password"
                      autoComplete="off"
                      className={input}
                      placeholder={config.secrets[s.name] ? '已填写，留空表示不修改' : '未填写'}
                      value={secrets[s.name] ?? ''}
                      onChange={(e) => {
                        clearFeedback()
                        setSecrets({ ...secrets, [s.name]: e.target.value })
                      }}
                    />
                    {s.help && <span className="ui-help">{s.help}</span>}
                  </label>
                ))}
                <SchemaForm
                  schema={provider.settingsSchema as ObjectSchema}
                  value={settings}
                  onNumberEdit={() => {
                    clearFeedback()
                    setNumberEditing(true)
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
                  onClick={() => save()}
                  className="ui-btn ui-btn-primary"
                >
                  保存
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
            <ul className="rounded-lg ring-1 ring-line">
              {catalog.providers.map((p) => (
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
        .filter((m) => m.capabilities.includes(cap))
        .map((m) => ({ value: `${p.id}:${m.id}`, label: `${p.title} · ${m.title ?? m.id}` })),
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
