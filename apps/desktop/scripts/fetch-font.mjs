// 打包前准备字幕字体：Noto Sans CJK SC Regular（SIL OFL 1.1），放进 stage/fonts，随安装包附带。
// 导出烧字幕（ffmpeg 的 libass）和预览字幕（浏览器里的 libass）用同一个字体文件，样式才一致。
// 固定到 notofonts/noto-cjk 的 Sans2.004 标签并校验 SHA-256；已下载且校验通过时跳过。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const URL_ =
  'https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf'
const SHA256 = '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b'
const LICENSE_URL = 'https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/LICENSE'

const dir = fileURLToPath(new URL('../stage/fonts', import.meta.url))
const file = join(dir, 'NotoSansCJKsc-Regular.otf')
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

const ready = () =>
  existsSync(file) &&
  existsSync(join(dir, 'LICENSE-NotoSansCJK.txt')) &&
  sha(readFileSync(file)) === SHA256
if (ready()) {
  console.log('字幕字体已就绪：', file)
} else {
  mkdirSync(dir, { recursive: true })
  console.log('下载字幕字体：', URL_)
  const res = await fetch(URL_)
  if (!res.ok) throw new Error(`下载字幕字体失败：${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (sha(buf) !== SHA256) throw new Error('字幕字体校验失败（SHA-256 不符）')
  writeFileSync(`${file}.part`, buf)
  renameSync(`${file}.part`, file)
  // OFL 要求随字体附带许可证
  const license = await fetch(LICENSE_URL)
  if (!license.ok) throw new Error(`下载字体许可证失败：${license.status}`)
  writeFileSync(join(dir, 'LICENSE-NotoSansCJK.txt'), await license.text())
  console.log('字幕字体已下载：', file)
}
