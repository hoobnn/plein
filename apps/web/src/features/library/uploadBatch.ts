export interface UploadNotice {
  message: string | null
  failed: boolean
}
export interface UploadBatchResult extends UploadNotice {
  ids: string[]
}

/** 每个文件独立上传；成功项保留，失败项明确列出，不静默截断或重复添加。 */
export async function uploadBatch(
  files: File[],
  want: 'image' | 'video',
  upload: (file: File) => Promise<{ id: string }>,
  { capacity = 24, used = [] }: { capacity?: number; used?: string[] } = {},
): Promise<UploadBatchResult> {
  const empty = { ids: [], message: null, failed: false }
  if (!files.length) return empty
  const label = want === 'image' ? '图片' : '视频'
  const unit = want === 'image' ? '张' : '个'
  const valid = files.filter((file) => file.type.startsWith(`${want}/`))
  if (!valid.length) return { ...empty, failed: true, message: `只能放${label}` }
  const room = Math.max(0, capacity)
  if (valid.length > room)
    return {
      ...empty,
      failed: true,
      message: `本次选择了 ${valid.length} ${unit}${label}，最多还能添加 ${room} ${unit}，请减少后重试。`,
    }
  const seen = new Set(used)
  const ids: string[] = []
  const failures: Array<{ name: string; message: string }> = []
  let duplicates = 0
  for (const file of valid) {
    try {
      const asset = await upload(file)
      if (seen.has(asset.id)) duplicates++
      else {
        seen.add(asset.id)
        ids.push(asset.id)
      }
    } catch (error) {
      failures.push({
        name: file.name,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const notes: string[] = []
  if (failures.length) {
    if (files.length === 1) notes.push(failures[0]!.message)
    else
      notes.push(
        `已添加 ${ids.length} ${unit}${label}，${failures.length} ${unit}上传失败（${failures.map((failure) => failure.name).join('、')}）：${[...new Set(failures.map((failure) => failure.message))].join('；')}。请重选失败文件重试。`,
      )
  }
  const skipped = files.length - valid.length
  if (skipped) notes.push(`已跳过 ${skipped} 个非${label}文件。`)
  if (duplicates) notes.push(`已跳过 ${duplicates} ${unit}重复${label}。`)
  return { ids, message: notes.join(' ') || null, failed: failures.length > 0 }
}
