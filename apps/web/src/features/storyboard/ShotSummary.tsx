import { resolveShotAsset } from '@plein/capabilities'
import type { Engine } from '@plein/canvas-core'
import { getCreativeReview } from '@plein/doc'
import {
  findMentions,
  hasVoice,
  pickVoice,
  voiceOf,
  type Mention,
  type MentionTarget,
  type Shot,
  type VoiceRef,
} from '@plein/nodes'
import type { InputRef, PreparedInput } from '@plein/protocol'
import type { UseQueryResult } from '@tanstack/react-query'
import { useMemo } from 'react'
import { assetUrls } from '../../api/client'
import { submittedMedia } from '../generator/submittedMedia'

export function ShotSummary({
  engine,
  shot,
  promptText,
  promptSource,
  targets,
  speechVoices,
  input,
  onLocate,
  onChoose,
}: {
  engine: Engine
  shot: Shot
  /** 所展示阶段的实际提示词，或无节点时按回退规则推导的结果 */
  promptText: string
  promptSource: string
  targets: MentionTarget[]
  speechVoices: ReadonlyMap<string, VoiceRef[]>
  input: UseQueryResult<PreparedInput>
  onLocate(id: string): void
  onChoose(): void
}) {
  const mentions = useMemo(() => findMentions(promptText, targets), [promptText, targets])
  // 没有出场资产时摘要只留一行，不占版面
  if (!shot.characters.length)
    return (
      <section className="space-y-2" aria-label="本镜用到的">
        <p className="text-xs text-ink-subtle">本镜用到的 · 尚未指定出场资产</p>
      </section>
    )
  return (
    <section className="space-y-2" aria-label="本镜用到的">
      <h3 className="font-medium">本镜用到的</h3>
      <p className="text-xs text-ink-subtle">档案项{promptSource}</p>
      <div className="flex flex-wrap gap-2">
        {shot.characters.map((name) => {
          const asset = resolveShotAsset(engine.doc, name, shot.assetBindings?.[name])
          if (!asset)
            return (
              <button
                type="button"
                className="ui-btn ui-btn-secondary"
                key={name}
                title="按名字或绑定无法唯一确定资产卡，去分镜表重新选择"
                onClick={onChoose}
              >
                {name} · 需要选择资产
              </button>
            )
          const matches = mentions.filter((m) => m.id === asset.id)
          // 同名未消歧或 #序号 越界时生成会被阻断，摘要不装作没看见
          const broken = mentions.some((m) => m.id === undefined && m.ids.includes(asset.id))
          // 档案项一致性与场景视角一起判断；一致的多处引用取第一个展示，不再误报也不丢设置
          const pickKey = (m: Mention) =>
            JSON.stringify([
              m.pick?.period?.id,
              m.pick?.outfit?.id,
              m.pick?.expression?.id,
              m.pick?.voiceState?.id,
              m.sceneView?.id,
            ])
          const consistent =
            matches.length > 1 &&
            new Set(matches.map(pickKey)).size === 1 &&
            matches.every(
              (m) =>
                m.profileMiss === undefined && !m.profileConflict && m.sceneViewMiss === undefined,
            )
          const match = matches.length === 1 || consistent ? matches[0] : undefined
          // 提示词写法对不上唯一档案项 / 视角时不猜，让用户去选
          const unclear =
            broken ||
            (matches.length > 1 && !consistent) ||
            (match !== undefined &&
              (match.profileMiss !== undefined ||
                !!match.profileConflict ||
                match.sceneViewMiss !== undefined))
          let hint: string | undefined
          if (broken) hint = '同名卡不止一张，提示词里没写清用哪张；在分镜表或镜头计划里加 #序号'
          else if (matches.length > 1) hint = '提示词里多处引用了此资产，请核对写法'
          else if (match?.profileMiss !== undefined)
            hint = `档案里没有「${match.profileMiss}」，点开卡片重新选择`
          else if (match?.profileConflict) hint = match.profileConflict
          else if (match?.sceneViewMiss !== undefined)
            hint = `场景没有「/${match.sceneViewMiss}」视角，点开卡片重新选择`
          const pick = match?.pick ?? {}
          const voice = pickVoice(pick, voiceOf(asset.params))
          const data = input.data && input.data.status !== 'unprepared' ? input.data : undefined
          const refs = data?.refs.filter((ref) => ref.elementId === asset.id)
          const firstFrameCount =
            data?.nodeType === 'plein/video' && data.params.mode === 'image'
              ? (data.inputs.images ?? []).length
              : undefined
          const sentImages = data
            ? submittedMedia(data).filter((item) => item.type === 'image')
            : []
          const hasSent =
            !!refs?.some((ref) => ref.sent.length) ||
            sentImages.some((item) => item.source === asset.id)
          // 没有可用图时明确说明未送参考图；有图没送是另一回事，原因收进 title
          const onlyText = !!refs?.length && !hasSent && refs.every((ref) => !ref.available.length)
          const notSent = !hasSent && !onlyText && !!refs?.some((ref) => !ref.sent.length)
          const reasonText = (ref: InputRef) => {
            if (ref.selected?.length === 0) return '已选择仅文字，不送参考图'
            if (ref.reason === 'failed') return '参考图生成失败，不追加文字设定'
            if (ref.reason === 'no_image') return '还没有可用的参考图，不追加文字设定'
            if (ref.reason === 'unsupported') return '当前模式不送参考图，不追加文字设定'
            if (ref.reason === 'over_limit') return '超过模型的参考图上限，不追加文字设定'
            if (ref.reason === 'selection_missing') return '所选参考图已失效'
            return '参考图没有送入'
          }
          const review = getCreativeReview(asset)
          // 配音节点显式指定的音色优先于角色卡沿用；同一角色多句不一致时单独提示
          const speechVoicesFor = speechVoices.get(asset.id) ?? []
          const voicePart =
            speechVoicesFor.length > 1
              ? '多句音色不同'
              : speechVoicesFor.length === 1
                ? '配音另指定'
                : (pick.voiceState?.name ?? (hasVoice(voice) ? '默认' : '未选'))
          const voiceText = `时期：${pick.period?.name ?? '默认'} · 服装：${pick.outfit?.name ?? '默认'} · 表情：${pick.expression?.name ?? '默认'} · 音色：${voicePart}`
          const speechTitle =
            speechVoicesFor.length > 1
              ? `各句配音音色：${speechVoicesFor.map((v) => v.voiceId).join('、')}`
              : speechVoicesFor.length === 1
                ? `配音节点指定了音色 ${speechVoicesFor[0]!.voiceId}`
                : undefined
          return (
            <button
              type="button"
              className="plein-shot-subject text-left"
              key={name}
              title={speechTitle ?? hint}
              onClick={broken ? onChoose : () => onLocate(asset.id)}
            >
              <span className="block font-medium">{name} · 调整资产</span>
              {asset.nodeType === 'plein/character' && (
                <span
                  className={unclear && !speechVoicesFor.length ? 'block text-warning' : 'block'}
                >
                  {broken ? '提示词引用不唯一' : unclear ? '档案项需要选择' : voiceText}
                </span>
              )}
              {asset.nodeType === 'plein/scene' && (
                <span className="block">
                  视角：
                  {broken
                    ? '引用不唯一'
                    : unclear
                      ? '需要选择'
                      : (match?.sceneView?.name ?? '默认')}
                  {match?.sceneView?.images[0] && (
                    <img
                      className="mt-1 h-20 w-32 object-contain"
                      src={assetUrls.original(match.sceneView.images[0])}
                      alt="场景视角截图"
                    />
                  )}
                </span>
              )}
              {hasSent && (
                <span
                  className="block text-ink-subtle"
                  title="按当前输入预览；已采用候选实际送入的素材以其生成依据为准"
                >
                  参考图将送入模型
                </span>
              )}
              {!hasSent && notSent && (
                <>
                  <span
                    className="block text-ink-subtle"
                    title={refs!
                      .filter((ref) => !ref.sent.length)
                      .map(reasonText)
                      .join('；')}
                  >
                    参考图将不送入
                  </span>
                  {firstFrameCount !== undefined && firstFrameCount > 0 && (
                    <span className="block text-ink-subtle">
                      首帧：已送入 {firstFrameCount} 张上游分镜图
                    </span>
                  )}
                </>
              )}
              {!hasSent && !notSent && onlyText && (
                <span className="block text-ink-subtle">无可用参考图</span>
              )}
              {review?.status === 'usable' && (
                <span className="block text-ink-subtle">已人工认可</span>
              )}
            </button>
          )
        })}
      </div>
    </section>
  )
}
