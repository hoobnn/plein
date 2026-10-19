/** 只读取固定大小的头尾；工程素材仍留在 Blob 中，不复制成整包 ArrayBuffer。 */
export async function validateProjectZip(blob: Blob) {
  const invalid = () => new Error('工程文件不完整或不是有效 ZIP，请重新导出')
  if (blob.size < 22) throw invalid()
  const [head, tail] = await Promise.all([
    blob.slice(0, 4).arrayBuffer(),
    blob.slice(-65_557).arrayBuffer(),
  ])
  if (new DataView(head).getUint32(0, true) !== 0x04034b50) throw invalid()
  const view = new DataView(tail)
  for (let at = view.byteLength - 22; at >= 0; at--) {
    if (
      view.getUint32(at, true) === 0x06054b50 &&
      at + 22 + view.getUint16(at + 20, true) === view.byteLength
    )
      return
  }
  throw invalid()
}
