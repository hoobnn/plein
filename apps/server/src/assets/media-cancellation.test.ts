import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { tempDir } from '../testing'
import { ffmpeg, setMediaTools, withMediaAbort, videoPacketTimes } from './media'

afterEach(() => setMediaTools({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }))
function fake() {
  const dir = tempDir('plein-ffmpeg-cancel-')
  const executable = join(dir, 'ffmpeg')
  writeFileSync(
    executable,
    `#!${process.execPath}\nconst fs=require('node:fs');const probe=process.argv.includes('-show_entries');const out=process.argv.at(probe?-1:-2);fs.writeFileSync(out+'.started',String(process.pid));setTimeout(()=>fs.writeFileSync(out,'done'),probe?30000:Number(process.argv.at(-1)));\n`,
  )
  chmodSync(executable, 0o755)
  setMediaTools({ ffmpeg: executable, ffprobe: executable })
  return dir
}
it('取消只结束自己的ffmpeg子进程，等待进程退出再释放；同时运行的加工正常完成', async () => {
  const dir = fake()
  const controller = new AbortController()
  const cancelled = join(dir, 'cancelled')
  const kept = join(dir, 'kept')
  const pending = withMediaAbort(controller.signal, () => ffmpeg([cancelled, '30000']))
  const observed = expect(pending).rejects.toThrow('取消本次加工')
  const parallel = ffmpeg([kept, '50'])
  await vi.waitFor(() => expect(existsSync(cancelled + '.started')).toBe(true))
  const pid = Number(readFileSync(cancelled + '.started', 'utf8'))
  controller.abort(new Error('取消本次加工'))
  await observed
  await parallel
  expect(existsSync(cancelled)).toBe(false)
  expect(readFileSync(kept, 'utf8')).toBe('done')
  expect(() => process.kill(pid, 0)).toThrow()
})
it('逐包PTS核验也响应取消，并等待ffprobe真正退出', async () => {
  const dir = fake()
  const controller = new AbortController()
  const file = join(dir, 'probe')
  const pending = withMediaAbort(controller.signal, () => videoPacketTimes(file))
  const observed = expect(pending).rejects.toThrow('取消时间戳核验')
  await vi.waitFor(() => expect(existsSync(file + '.started')).toBe(true))
  const pid = Number(readFileSync(file + '.started', 'utf8'))
  controller.abort(new Error('取消时间戳核验'))
  await observed
  expect(existsSync(file)).toBe(false)
  expect(() => process.kill(pid, 0)).toThrow()
})
it('预先取消的请求不启动ffmpeg，也不影响后续无signal调用', async () => {
  const dir = fake()
  const controller = new AbortController()
  controller.abort(new Error('已取消'))
  const out = join(dir, 'never-started')
  await expect(withMediaAbort(controller.signal, () => ffmpeg([out, '10']))).rejects.toThrow(
    '已取消',
  )
  expect(existsSync(out + '.started')).toBe(false)
  await ffmpeg([join(dir, 'next'), '10'])
  expect(readFileSync(join(dir, 'next'), 'utf8')).toBe('done')
})
