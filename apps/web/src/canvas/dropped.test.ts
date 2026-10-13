import { describe, expect, it } from 'vite-plus/test'
import { droppedFiles, visibleFiles } from './dropped'

/** 模拟拖入时 webkitGetAsEntry 给出的文件 / 文件夹条目 */
function file(path: string) {
  const name = path.split('/').pop()!
  return {
    isFile: true,
    isDirectory: false,
    name,
    fullPath: path,
    file: (ok: (f: File) => void) => ok(new File(['x'], name)),
  }
}

function dir(path: string, children: unknown[]) {
  return {
    isFile: false,
    isDirectory: true,
    name: path.split('/').pop()!,
    fullPath: path,
    createReader() {
      // 分两批返回，最后返回空数组表示读完
      const batches = [children.slice(0, 1), children.slice(1), []]
      return { readEntries: (ok: (e: unknown[]) => void) => ok(batches.shift() ?? []) }
    },
  }
}

function transfer(entries: unknown[], files: File[] = []) {
  return {
    items: entries.map((e) => ({ kind: 'file', webkitGetAsEntry: () => e })),
    files,
  } as unknown as DataTransfer
}

describe('拖入的文件', () => {
  it('没有文件夹时原样返回', async () => {
    const f = new File(['x'], 'a.png')
    expect(await droppedFiles(transfer([file('/a.png')], [f]))).toEqual([f])
  })

  it('文件夹展开成里面的文件，含子文件夹，按路径自然排序，跳过隐藏文件', async () => {
    const tree = dir('/素材', [
      file('/素材/镜头10.png'),
      dir('/素材/配音', [file('/素材/配音/a.wav'), file('/素材/配音/.DS_Store')]),
      file('/素材/镜头2.png'),
      dir('/素材/.git', [file('/素材/.git/HEAD')]),
    ])
    const names = (await droppedFiles(transfer([file('/封面.png'), tree]))).map((f) => f.name)
    expect(names).toEqual(['封面.png', '镜头2.png', '镜头10.png', 'a.wav'])
  })

  it('选文件夹时过滤系统文件', () => {
    const names = visibleFiles([
      new File([''], '.DS_Store'),
      new File([''], 'Thumbs.db'),
      new File([''], 'a.md'),
    ]).map((f) => f.name)
    expect(names).toEqual(['a.md'])
  })
})
