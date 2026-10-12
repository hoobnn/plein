/** 一次导入的文件数上限，误拖进整个素材盘时不至于卡死 */
export const MAX_IMPORT_FILES = 500

/** 隐藏文件和系统文件（.DS_Store、Thumbs.db 等）不导入 */
export function visibleFiles(files: File[]) {
  return files.filter((f) => !f.name.startsWith('.') && f.name !== 'Thumbs.db')
}

/**
 * 拖入的文件；拖进文件夹时展开成里面的文件（含子文件夹，文件夹内按路径排序，跳过隐藏文件）。
 * 必须在 drop 事件里同步调用：事件结束后 DataTransfer 就读不到了。
 */
export function droppedFiles(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items]
    .filter((i) => i.kind === 'file')
    .map((i) => i.webkitGetAsEntry())
    .filter((e): e is FileSystemEntry => !!e)
  if (!entries.some((e) => e.isDirectory)) return Promise.resolve([...dt.files])
  return (async () => {
    // 拖入的各项保持原顺序，文件夹里按路径排序
    const out: Array<{ path: string; file: File }> = []
    for (const e of entries) {
      const found: typeof out = []
      await walk(e, found, out.length)
      found.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true }))
      out.push(...found)
    }
    return visibleFiles(out.map((f) => f.file))
  })()
}

async function walk(
  entry: FileSystemEntry,
  out: Array<{ path: string; file: File }>,
  before: number,
) {
  if (before + out.length >= MAX_IMPORT_FILES || entry.name.startsWith('.')) return
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    ).catch(() => null)
    if (file) out.push({ path: entry.fullPath, file })
    return
  }
  if (!entry.isDirectory) return
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  // readEntries 每次只返回一批，读到空为止
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    ).catch(() => [])
    if (!batch.length) return
    for (const e of batch) await walk(e, out, before)
  }
}
