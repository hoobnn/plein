/** Reproduce: node apps/desktop/scripts/stage-server.mjs && PRODUCER_HEADLESS_SHELL_PATH=/absolute/chrome node apps/server/src/motion/stage-acceptance.build.mjs */
import { cp, mkdir, mkdtemp, readdir, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { build } from 'vite-plus/pack'

const here = dirname(fileURLToPath(import.meta.url)),
  repo = resolve(here, '../../../..')
const scratch = await mkdtemp(join(tmpdir(), 'plein-motion-stage-')),
  server = join(scratch, 'server')
await cp(join(repo, 'apps/desktop/stage/server'), server, { recursive: true, dereference: true })
await cp(join(repo, 'apps/desktop/stage/ffmpeg'), join(scratch, 'ffmpeg'), {
  recursive: true,
  dereference: true,
})
await mkdir(join(scratch, 'home'))
await mkdir(join(scratch, 'tmp'))
async function noLinks(dir) {
  for (const name of await readdir(dir)) {
    const file = join(dir, name),
      info = await lstat(file)
    if (info.isSymbolicLink()) throw new Error(`Stage retains a source symlink: ${file}`)
    if (info.isDirectory()) await noLinks(file)
  }
}
await noLinks(server)
const external = (id) =>
  id.startsWith('@hyperframes/') ||
  ['gsap', '@fontsource/noto-sans-sc', 'linkedom'].some(
    (name) => id === name || id.startsWith(name + '/'),
  )
await build({
  config: false,
  cwd: join(repo, 'apps/server'),
  entry: { acceptance: join(here, 'stage-acceptance.ts') },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: server,
  clean: false,
  dts: false,
  deps: {
    alwaysBundle: (id) => !external(id),
    neverBundle: [/^@hyperframes\//, 'gsap', '@fontsource/noto-sans-sc', 'linkedom'],
  },
  banner: {
    js: "import { createRequire as __stageRequire } from 'node:module'; var require = __stageRequire(import.meta.url);",
  },
  logLevel: 'warn',
})
const node =
  process.env.PLEIN_MOTION_STAGE_NODE ??
  join(repo, 'apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const child = spawn(node, [join(server, 'acceptance.mjs')], {
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
    code === 0
      ? done()
      : fail(new Error(`Isolated staged acceptance exited ${code}; artifacts: ${scratch}`)),
  )
})
