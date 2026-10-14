import { z } from 'zod'

/** 用户存的模板：Frame 和里面的元素、内部连线，格式同复制粘贴（ClipboardData） */
export const TemplateData = z.object({
  plein: z.literal(1),
  elements: z
    .array(z.looseObject({ id: z.string(), kind: z.string() }))
    .min(1)
    .max(500),
  edges: z.array(z.looseObject({ id: z.string() })).max(2000),
})
export const CreateTemplate = z.object({
  title: z.string().trim().min(1).max(60),
  data: TemplateData,
})
export interface UserTemplate {
  id: string
  title: string
  createdAt: number
  data: z.infer<typeof TemplateData>
}
