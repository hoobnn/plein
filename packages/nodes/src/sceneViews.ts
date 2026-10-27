import { z } from 'zod'
import { PanoramaViewSource } from './panorama'

/** 与 mentions.ts 的 @ 终止字符保持一致，视角后可直接接标点或另一处引用。 */
const STOP = /[\s@，。,.!！?？:：;；、（）()【】[\]「」"'“”]/
const WORD = /^[^\s/@#，。,.!！?？:：;；、（）()【】[\]「」"'“”]+/

/** 场景视角独立命名；图片顺序只影响该视角内部，不自动混入基础场景图。 */
export const SceneView = z.object({
  id: z.string().min(1).max(40),
  name: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[^/@#\s]+$/),
  aliases: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(20)
        .regex(/^[^/@#\s]+$/),
    )
    .max(8)
    .default([]),
  description: z.string().max(1000).default(''),
  panorama: PanoramaViewSource.optional(),
  images: z
    .array(z.string().regex(/^[0-9a-f]{64}$/))
    .max(4)
    .default([]),
})
export type SceneView = z.infer<typeof SceneView>
export const SceneViews = z.array(SceneView).max(24)
export function sceneViewsOf(raw: unknown): SceneView[] {
  const parsed = SceneViews.safeParse(raw ?? [])
  return parsed.success ? parsed.data : []
}
export const sceneViewImages = (raw: unknown) => [
  ...new Set(sceneViewsOf(raw).flatMap((v) => v.images)),
]
/** Strong references include the original projection source, never appended to model inputs. */
export const sceneViewAssets = (raw: unknown) => [
  ...new Set(
    sceneViewsOf(raw).flatMap((view) => [
      ...view.images,
      ...(view.panorama ? [view.panorama.assetId] : []),
    ]),
  ),
]

export function sceneViewProblem(views: SceneView[], next: string, exceptId?: string) {
  const name = next.trim()
  if (!name || name.length > 20 || /[/@#\s]/.test(name))
    return '视角名需为 1–20 字，不能含空格或 / @ #'
  if (views.some((v) => v.id !== exceptId && [v.name, ...v.aliases].includes(name)))
    return '视角名或旧名已被使用'
  return undefined
}
export function matchSceneView(rest: string, views: SceneView[]) {
  if (!rest.startsWith('/')) return undefined
  const candidates = views
    .flatMap((view) => [...new Set([view.name, ...view.aliases])].map((name) => ({ view, name })))
    .filter(
      (v) =>
        rest.startsWith(`/${v.name}`) &&
        (rest.length === v.name.length + 1 || STOP.test(rest.charAt(v.name.length + 1))),
    )
    .sort((a, b) => b.name.length - a.name.length)
  const hit = candidates[0]
  if (hit && candidates.filter((v) => v.name === hit.name).length === 1)
    return { view: hit.view, length: hit.name.length + 1 }
  return {
    miss: rest.slice(1).match(WORD)?.[0] ?? '',
    length: 0,
  }
}
