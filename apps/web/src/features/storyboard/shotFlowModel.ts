import type { PleinDoc } from '@plein/doc'
import { resolveShotAsset, shotAssetMention } from '@plein/capabilities'
import { planParams, type Shot } from '@plein/nodes'

/** 本地拼接，生成视频仍经过原有的模型选择、实际输入和批量清单。 */
export function composeShotPrompts(doc: PleinDoc, shot: Shot, style: string) {
  const mentions = shot.characters
    .map((name) => {
      const el = resolveShotAsset(doc, name, shot.assetBindings?.[name])
      return el ? shotAssetMention(doc, el) : name
    })
    .join('、')
  const base = { ...shot, imagePrompt: '', motionPrompt: '' }
  const picture = planParams(base, 'image', { mentions }).prompt as string
  const video = planParams(base, 'video').prompt as string
  const dialogue = shot.dialogue.map((d) => `${d.character || '旁白'}：${d.line}`).join('\n')
  return {
    imagePrompt: [picture, style.trim() && `视觉风格：${style.trim()}`]
      .filter(Boolean)
      .join('\n\n'),
    motionPrompt: [
      video,
      mentions && `出场资产：${mentions}`,
      dialogue && `对白与旁白：\n${dialogue}`,
      shot.sfx.trim() && `音效：${shot.sfx.trim()}`,
      style.trim() && `视觉风格：${style.trim()}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  }
}
