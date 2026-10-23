/** Separate Node entry. This must be emitted as motion/worker.mjs by the server build. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface WorkerRequest {
  projectDir: string
  outputPath: string
  useGpu: boolean
  chromePath?: string
}
const controller = new AbortController()
process.on('SIGTERM', () => controller.abort())
process.on('message', (message: unknown) => {
  if (message && typeof message === 'object' && 'cancel' in message) controller.abort()
})
const send = (message: unknown) => {
  if (process.connected) process.send?.(message)
}
process.once('message', async (request: WorkerRequest) => {
  try {
    const [{ openComposition }, { createRenderJob, executeRenderJob }] = await Promise.all([
      import('@hyperframes/sdk'),
      import('@hyperframes/producer'),
    ])
    // Parse/stamp once: source package and actual render consume the same frozen HTML.
    const file = join(request.projectDir, 'index.html')
    const comp = await openComposition(await readFile(file, 'utf8'), { history: false })
    await writeFile(file, comp.serialize())
    comp.dispose()
    const job = createRenderJob({
      fps: 30,
      quality: 'standard',
      format: 'mp4',
      strictness: 'strict',
      useGpu: request.useGpu,
      workers: 1,
    })
    await executeRenderJob(
      job,
      request.projectDir,
      request.outputPath,
      (current, message) => {
        send({ type: 'progress', stage: current.currentStage, percent: current.progress, message })
      },
      controller.signal,
    )
    send({ type: 'complete', warnings: job.warnings, outcome: job.outcome })
    process.exitCode = 0
  } catch (error) {
    send({
      type: 'error',
      code: controller.signal.aborted ? 'motion_cancelled' : 'motion_render_failed',
      message: error instanceof Error ? error.message : String(error),
    })
    process.exitCode = 1
  } finally {
    process.disconnect?.()
  }
})
