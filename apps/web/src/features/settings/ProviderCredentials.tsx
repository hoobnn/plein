/**
 * 平台的「密钥」区：一组密钥一张紧凑卡片。已保存的密钥只显示掩码，
 * 「更换」就地展开输入，取消恢复掩码；没保存过的新卡直接给输入框。
 * 草稿由行组件持有，保存时随设置一起提交；这里只渲染并转发操作。
 */

import type { ProviderConfigView, ProviderInfo } from '@plein/protocol'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { usageSummary } from './credentialUsage'
import { credentialCardDirty, type CredentialCardDraft } from './providerDirty'

interface CardProps {
  provider: ProviderInfo
  card: CredentialCardDraft
  /** 已保存组的元信息；新卡没有 */
  saved?: ProviderConfigView['credentials'][number]
  /** 这张卡是不是当前使用中的组 */
  active: boolean
  /** 组数 ≥2 时才显示「使用中」和「设为使用」，单组界面保持安静 */
  multi: boolean
  /** 平台级设置还有没保存的改动：检查连接查的是整体配置，得先保存 */
  settingsDirty: boolean
  /** 在草稿卡里的序号：没填标签时用「新密钥组 N」作名字，多张卡不重名 */
  draftIndex?: number
  onLabel(key: string, value: string): void
  onSecret(key: string, name: string, value: string): void
  onUse(key: string): void
  onRemove(key: string): void
  onDiscard(key: string): void
  onTest(key: string): void
  /** 密钥输入里回车：交给行组件保存（未配置平台会保存并校验） */
  onSubmit(): void
  /** 保存成功后由行组件递增：收起就地输入、复位明文状态 */
  resetToken: number
}

function CredentialCard({
  provider,
  card,
  saved,
  active,
  multi,
  settingsDirty,
  draftIndex,
  onLabel,
  onSecret,
  onUse,
  onRemove,
  onDiscard,
  onTest,
  onSubmit,
  resetToken,
}: CardProps) {
  // 就地更换的密钥字段、以及显示/隐藏明文的状态
  const [editing, setEditing] = useState<Record<string, boolean>>({})
  const [shown, setShown] = useState<Record<string, boolean>>({})
  const typed = Object.values(card.secrets).some((v) => v !== '')
  // 只有保存成功（行组件递增 resetToken）或用户点取消才收起就地输入；
  // 输入到一半删空不该把输入框收走、丢掉焦点。
  const firstReset = useRef(true)
  useEffect(() => {
    if (firstReset.current) {
      firstReset.current = false
      return
    }
    setEditing({})
    setShown({})
  }, [resetToken])
  // 新卡用草稿标签作名字，没填时退回序号；已保存组用已保存的标签
  const name =
    saved?.label ??
    (card.label.trim() || (draftIndex === undefined ? '新密钥组' : `新密钥组 ${draftIndex + 1}`))
  // 名下还有未取回的结果或音色时给一行轻量说明，全为 0 不显示
  const summary = saved ? usageSummary(saved.usage) : null
  // 标签必填只约束要创建的新卡：预填卡改动后提交时必须带标签；已保存组留空表示不修改，
  // 只填新密钥也要能保存
  const labelRequired =
    saved === undefined &&
    (card.baseline === undefined || credentialCardDirty(card)) &&
    !card.label.trim()
  const enter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    e.preventDefault()
    onSubmit()
  }

  return (
    <li
      className="flex flex-col gap-2.5 rounded-lg bg-surface-2/60 p-3 ring-1 ring-line"
      data-credential={card.key}
    >
      <div className="flex items-center gap-2">
        <input
          type="text"
          className="ui-input min-w-0 flex-1"
          aria-label={`「${name}」的标签`}
          placeholder={saved ? saved.label : '个人 / 团队'}
          value={card.label}
          aria-invalid={labelRequired || undefined}
          onChange={(e) => onLabel(card.key, e.target.value)}
          onKeyDown={enter}
        />
        {multi && active && <span className="ui-tag">使用中</span>}
        {multi && saved && !active && (
          <button
            type="button"
            className="ui-btn ui-btn-secondary flex-none"
            aria-label={`设为使用「${name}」`}
            onClick={() => onUse(card.key)}
          >
            设为使用
          </button>
        )}
        {saved ? (
          <button
            type="button"
            className="ui-btn ui-btn-quiet ui-btn-danger flex-none"
            aria-label={`删除「${name}」`}
            onClick={() => onRemove(card.key)}
          >
            删除
          </button>
        ) : (
          // 预填卡是新平台创建第一组的入口，不提供移除；手动加的草稿可以直接丢弃
          card.baseline === undefined && (
            <button
              type="button"
              className="ui-btn ui-btn-quiet flex-none"
              aria-label={`移除「${name}」`}
              onClick={() => onDiscard(card.key)}
            >
              移除
            </button>
          )
        )}
      </div>
      {/* 单组无从切换，只在删除/替换确认里说影响；≥2 组时才在卡片上常驻摘要 */}
      {multi && saved && summary && <p className="text-xs text-ink-subtle">{summary}</p>}
      {provider.secrets.map((s) => {
        const filled = saved?.secrets[s.name]
        const hint = saved?.secretHints?.[s.name]
        // 已保存且填过的密钥默认只显示掩码，点「更换」才就地展开输入
        if (saved && filled && !editing[s.name]) {
          return (
            <div
              key={s.name}
              className="flex min-w-0 items-center gap-2 rounded-md bg-surface px-2.5 py-1.5 ring-1 ring-line"
            >
              <span className="ui-label flex-none">{s.title}</span>
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink-muted">
                {hint ?? '••••••••'}
              </code>
              <button
                type="button"
                className="ui-btn ui-btn-quiet ui-btn-xs flex-none"
                aria-label={`更换「${name}」的${s.title}`}
                onClick={() => setEditing((current) => ({ ...current, [s.name]: true }))}
              >
                更换
              </button>
            </div>
          )
        }
        return (
          <div key={s.name} className="flex flex-col gap-1.5">
            <span className="ui-label">
              {s.title}
              {s.required ? '' : '（可选）'}
            </span>
            <div className="flex items-center gap-1.5">
              <input
                type={shown[s.name] ? 'text' : 'password'}
                autoComplete="off"
                className="ui-input min-w-0 flex-1"
                aria-label={`「${name}」的${s.title}`}
                placeholder={filled ? '已填写，留空表示不修改' : '未填写'}
                value={card.secrets[s.name] ?? ''}
                // 粘贴进去的密钥常带首尾空白：直接 trim 掉
                onChange={(e) => onSecret(card.key, s.name, e.target.value.trim())}
                onKeyDown={enter}
              />
              <button
                type="button"
                className="ui-btn ui-btn-quiet ui-btn-xs flex-none"
                aria-label={`${shown[s.name] ? '隐藏' : '显示'}「${name}」的密钥`}
                aria-pressed={!!shown[s.name]}
                onClick={() => setShown((current) => ({ ...current, [s.name]: !current[s.name] }))}
              >
                {shown[s.name] ? '隐藏' : '显示'}
              </button>
              {saved && filled && (
                <button
                  type="button"
                  className="ui-btn ui-btn-quiet ui-btn-xs flex-none"
                  aria-label={`取消更换「${name}」的密钥`}
                  onClick={() => {
                    // 取消恢复原密钥：清掉这次的输入，回到掩码，明文状态一并复位
                    onSecret(card.key, s.name, '')
                    setEditing((current) => ({ ...current, [s.name]: false }))
                    setShown((current) => ({ ...current, [s.name]: false }))
                  }}
                >
                  取消
                </button>
              )}
            </div>
            {s.help && <span className="ui-help">{s.help}</span>}
          </div>
        )
      })}
      {saved && (
        // 有没保存的密钥输入或平台设置时禁用：检查的是已保存的整体配置，不先保存会查到旧值
        <button
          type="button"
          className="ui-btn ui-btn-secondary self-start"
          disabled={settingsDirty || typed}
          aria-label={`检查「${name}」的连接`}
          onClick={() => onTest(card.key)}
        >
          重新校验
        </button>
      )}
    </li>
  )
}

/** 密钥区的入口：按服务端视图加本地草稿拼出卡片列表，末尾是「添加一组密钥」 */
export function ProviderCredentials({
  provider,
  config,
  labels,
  groupSecrets,
  drafts,
  settingsDirty,
  onLabel,
  onSecret,
  onUse,
  onRemove,
  onDiscard,
  onTest,
  onAdd,
  onSubmit,
  resetToken,
}: {
  provider: ProviderInfo
  config: ProviderConfigView
  /** 已保存组的标签草稿：组 id → 输入；留空表示不修改 */
  labels: Record<string, string>
  /** 已保存组的密钥草稿：组 id → 密钥名 → 输入；留空表示不修改 */
  groupSecrets: Record<string, Record<string, string>>
  /** 还没保存过的新卡 */
  drafts: CredentialCardDraft[]
  /** 平台级设置还有没保存的改动，存在时禁用各卡的检查连接 */
  settingsDirty: boolean
  onLabel(key: string, value: string): void
  onSecret(key: string, name: string, value: string): void
  onUse(key: string): void
  onRemove(key: string): void
  onDiscard(key: string): void
  onTest(key: string): void
  onAdd(): void
  onSubmit(): void
  /** 保存成功后行组件递增，卡片据此收起就地输入 */
  resetToken: number
}) {
  // 平台没有声明密钥就没有组的概念；老版服务端的视图没有 credentials 字段也照常显示
  if (provider.secrets.length === 0) return null
  const savedGroups = config.credentials ?? []
  const multi = savedGroups.length + drafts.length >= 2
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="ui-label">密钥</span>
        {/* 平台文档里能找到申请密钥的入口的，直接给外链 */}
        {provider.docsUrl && (
          <a
            href={provider.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline"
          >
            获取密钥
          </a>
        )}
      </div>
      {savedGroups.length === 0 && drafts.length > 0 && (
        <p className="text-xs text-ink-subtle">
          填好密钥并启用后，「{provider.title}」的模型就能在节点里选到。
        </p>
      )}
      <ul aria-label="密钥组" className="flex flex-col gap-2">
        {savedGroups.map((saved) => (
          <CredentialCard
            key={saved.id}
            provider={provider}
            card={{
              key: saved.id,
              label: labels[saved.id] ?? '',
              secrets: groupSecrets[saved.id] ?? {},
              baseline: saved.label,
            }}
            saved={saved}
            active={config.activeCredential === saved.id}
            multi={multi}
            settingsDirty={settingsDirty}
            onLabel={onLabel}
            onSecret={onSecret}
            onUse={onUse}
            onRemove={onRemove}
            onDiscard={onDiscard}
            onTest={onTest}
            onSubmit={onSubmit}
            resetToken={resetToken}
          />
        ))}
        {drafts.map((card, draftIndex) => (
          <CredentialCard
            key={card.key}
            provider={provider}
            card={card}
            active={false}
            multi={multi}
            settingsDirty={settingsDirty}
            draftIndex={draftIndex}
            onLabel={onLabel}
            onSecret={onSecret}
            onUse={onUse}
            onRemove={onRemove}
            onDiscard={onDiscard}
            onTest={onTest}
            onSubmit={onSubmit}
            resetToken={resetToken}
          />
        ))}
      </ul>
      <button type="button" className="ui-btn ui-btn-secondary self-start" onClick={onAdd}>
        添加一组密钥
      </button>
    </section>
  )
}
