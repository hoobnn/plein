import { addNode, request } from '../testing'
import { hasFfmpeg } from '../assets/media'
import { sequenceSegmentFixture } from '../runs/sequence-segment-fixture'
import { mockProvider } from '@plein/providers'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { API, type StoryboardBatchPlan } from '@plein/protocol'
import { AgentChanges } from './changes'
import { Approvals } from './approvals'
import { agentTools } from './tools'
import { callTool } from './mcp'

const available = await hasFfmpeg()
afterEach(() => vi.restoreAllMocks())
describe.skipIf(!available)('P11 Agent/UI共用精确sequence范围', () => {
  it('多序列未选blocked，显式第二shot固定reuse与HTTP一致，token不能借另一scope', async () => {
    const f = await sequenceSegmentFixture(),
      submit = vi.spyOn(mockProvider, 'submit')
    const other = addNode(f.doc, 'plein/sequence', {
      nodeVersion: 2,
      params: {
        instanceVersion: 2,
        clips: [{ ...f.fixed(1), clipInstanceId: 'other-use', in: 1, out: 3 }],
      },
    })
    const env = {
      canvasId: f.id,
      ownerId: 'local',
      rooms: f.server.rooms,
      runs: f.server.runs,
      host: f.server.plugins,
      assets: f.server.assets,
      library: f.server.library,
    }
    const changes = new AgentChanges(
      'sequence-scope-test',
      f.id,
      'local',
      f.server.rooms,
      f.server.runs,
    )
    changes.begin('turn')
    const tools = agentTools(env, {
      changes,
      approvals: new Approvals(() => {}),
      mode: () => 'auto',
    })
    const call = async (args: Record<string, unknown>) => {
      const result = await callTool(
        tools.find((tool) => tool.name === 'run_storyboard')!,
        args,
      )
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
      return {
        text,
        value: () => JSON.parse(text) as { plan: StoryboardBatchPlan; status: string },
      }
    }
    try {
      const args = { id: f.board, role: 'video', shot_ids: [f.shots[1]!.id], reuse_existing: true }
      const ambiguous = await call({ ...args, preview_only: true })
      expect(ambiguous.value().plan.summary.blocked).toBe(1)
      const selected = (
        await call({ ...args, sequence_id: f.sequence, preview_only: true })
      ).value()
      expect(selected.plan.summary).toMatchObject({ run: 0, reuse: 1, calls: 0 })
      expect(selected.plan.scope?.sequenceId).toBe(f.sequence)
      const response = await request(f.server, API.storyboardBatchPreview(f.id, f.board), {
        method: 'POST',
        body: JSON.stringify(selected.plan.request),
      })
      // Route identity is shared with the UI; no independently reconstructed mapping.
      const http = (await response.json()) as StoryboardBatchPlan
      expect(response.status).toBe(200)
      expect(http.rows).toEqual(selected.plan.rows)
      expect(http.scope).toEqual(selected.plan.scope)
      const mismatch = await call({ ...args, sequence_id: other, token: selected.plan.token })
      expect(mismatch.text).toContain('范围与请求不一致')
      expect(submit).not.toHaveBeenCalled()
    } finally {
      changes.release()
    }
  }, 30_000)
})
