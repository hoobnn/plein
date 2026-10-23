/** Reuse a successful isolated stage: PLEIN_MOTION_STAGE_REUSE=/absolute/stage-root PLEIN_MOTION_REUSED_VIDEO=/absolute/previous-output.mp4 PRODUCER_HEADLESS_SHELL_PATH=/absolute/chrome node apps/server/src/motion/matrix-acceptance.build.mjs */
import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { build } from 'vite-plus/pack'
const here = dirname(fileURLToPath(import.meta.url)),
  repo = resolve(here, '../../../..')
const scratch = process.env.PLEIN_MOTION_STAGE_REUSE
if (!scratch) throw new Error('Set PLEIN_MOTION_STAGE_REUSE to the completed isolated stage root')
async function size(dir) {
  let bytes = 0,
    files = 0
  for (const name of await readdir(dir)) {
    const path = join(dir, name),
      entry = await stat(path)
    if (entry.isDirectory()) {
      const sub = await size(path)
      bytes += sub.bytes
      files += sub.files
    } else if (entry.isFile()) {
      bytes += entry.size
      files++
    }
  }
  return { bytes, files }
}
const stageServer = await size(join(repo, 'apps/desktop/stage/server'))
stageServer.measurement =
  'Logical uncompressed sum of regular file sizes in product stage/server, excluding acceptance harnesses in the separate copy.'
const reused = JSON.parse(
  await readFile(join(repo, 'docs/benchmarks/hyperframes/source-media-acceptance.json'), 'utf8'),
)
const reusedVideoOutput = process.env.PLEIN_MOTION_REUSED_VIDEO
if (!reusedVideoOutput)
  throw new Error('Set PLEIN_MOTION_REUSED_VIDEO to the earlier verified source-audio MP4')
await writeFile(
  join(scratch, 'matrix-metadata.json'),
  JSON.stringify({ stageServer, reusedVideoOutput, reusedVideoParams: reused.params }),
)
const external = (id) =>
  id.startsWith('@hyperframes/') ||
  ['gsap', '@fontsource/noto-sans-sc', 'linkedom'].some(
    (name) => id === name || id.startsWith(name + '/'),
  )
await build({
  config: false,
  cwd: join(repo, 'apps/server'),
  entry: { matrix: join(here, 'matrix-acceptance.ts') },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: join(scratch, 'server'),
  clean: false,
  dts: false,
  deps: {
    alwaysBundle: (id) => !external(id),
    neverBundle: [/^@hyperframes\//, 'gsap', '@fontsource/noto-sans-sc', 'linkedom'],
  },
  banner: {
    js: "import { createRequire as __matrixRequire } from 'node:module'; var require = __matrixRequire(import.meta.url);",
  },
  logLevel: 'warn',
})
const node =
  process.env.PLEIN_MOTION_STAGE_NODE ??
  join(repo, 'apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const child = spawn(node, [join(scratch, 'server/matrix.mjs')], {
  cwd: scratch,
  env: {
    PATH: '/usr/bin:/bin',
    HOME: join(scratch, 'home'),
    TMPDIR: join(scratch, 'tmp'),
    LANG: 'en_US.UTF-8',
    ELECTRON_RUN_AS_NODE: '1',
    PLEIN_FFMPEG_PATH: join(scratch, 'ffmpeg/ffmpeg'),
    PLEIN_FFPROBE_PATH: join(scratch, 'ffmpeg/ffprobe'),
    PRODUCER_HEADLESS_SHELL_PATH: process.env.PRODUCER_HEADLESS_SHELL_PATH,
  },
  stdio: 'inherit',
})
await new Promise((done, fail) => {
  child.once('error', fail)
  child.once('close', (code) =>
    code === 0 ? done() : fail(new Error(`Positive matrix exited ${code}`)),
  )
})
