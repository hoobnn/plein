import { z } from 'zod'

/** 项目：一部片子的容器，下面挂多张画布，项目资产（角色、场景……）可以归到项目里 */
export const Project = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  /** 项目或其下任一画布最后修改的时间 */
  updatedAt: z.number(),
  /** 画布数 */
  canvases: z.number(),
  /** 最近修改的画布，打开项目时进入它 */
  lastCanvasId: z.string().nullable(),
  /** 列表专用：项目里最近的几张图片 / 视频封面地址 */
  covers: z.array(z.string()).optional(),
})
export type Project = z.infer<typeof Project>

export const CreateProject = z.object({
  title: z.string().trim().min(1).max(200).default('未命名项目'),
})
export type CreateProject = z.input<typeof CreateProject>

export const UpdateProject = z.object({ title: z.string().trim().min(1).max(200) })
export type UpdateProject = z.infer<typeof UpdateProject>
