import { z } from 'zod'

export const Canvas = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** 列表专用：画布里最近的几张图片 / 视频封面地址，做首页缩略图 */
  covers: z.array(z.string()).optional(),
  /** 列表专用：顶层以外也算在内的元素数 */
  elements: z.number().optional(),
})
export type Canvas = z.infer<typeof Canvas>

export const CreateCanvas = z.object({
  title: z.string().trim().min(1).max(200).default('未命名画布'),
  /** 建在哪个项目下；不填时新建一个同名项目（旧客户端、脚本照常可用） */
  projectId: z.string().max(100).optional(),
})
export type CreateCanvas = z.input<typeof CreateCanvas>

export const UpdateCanvas = z.object({ title: z.string().trim().min(1).max(200) })
export type UpdateCanvas = z.infer<typeof UpdateCanvas>
