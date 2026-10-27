// @vitest-environment happy-dom
import {
  confirmProductionContent,
  createElement,
  productionContentSnapshot,
  setParams,
  type PleinDoc,
} from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { Shot } from '@plein/nodes'
import { LOCAL_PRINCIPAL } from '@plein/protocol'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useDocVersion } from '../../canvas/hooks'
import { useSession } from '../../stores/session'
import { act, renderApp, screen, within } from '../../testing/render'
import { creationGuideFacts } from './facts'
import { ProductionDetails } from './ProductionDetails'

const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))
function fixture(readOnly = false) {
  const doc = openDoc()
  docs.push(doc)
  const shots = [Shot.parse({ id: 'shot', no: 1, description: '递出信封' })]
  const boardId = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/storyboard',
    params: { shots },
    x: 0,
    y: 0,
    w: 200,
    h: 100,
  })
  doc.readOnly = readOnly
  useSession.setState({
    info: { principal: LOCAL_PRINCIPAL, authRequired: false, needsSetup: false },
  })
  const readCurrent = () => creationGuideFacts(doc, { boardId, canvasId: 'c' })
  function Harness() {
    useDocVersion(doc)
    return (
      <ProductionDetails
        doc={doc}
        canvasId="c"
        board={doc.get(boardId)!}
        writable={!doc.readOnly}
        readCurrent={readCurrent}
        onError={vi.fn()}
      />
    )
  }
  return { doc, boardId, shots, ...renderApp(<Harness />) }
}

it('核对历史空态说明旧标记无效，只读仍可查看但不能确认', async () => {
  const f = fixture(true)
  await f.user.click(screen.getByText('分镜核对历史（0）'))
  expect(screen.getByRole('list', { name: '分镜核对历史' }).textContent).toContain(
    '尚无文档内的人工核对记录；旧本机标记不作为确认。',
  )
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: '我已人工核对这份分镜' }).disabled,
  ).toBe(true)
  expect(screen.getByRole('status').textContent).toContain('当前只读')
  expect(f.doc.get(f.boardId)?.production?.confirmations ?? []).toEqual([])
})

it('核对历史区分当前内容、改版旧记录、同内容旧核对及其他画布范围', async () => {
  const f = fixture()
  await f.user.click(screen.getByRole('button', { name: '我已人工核对这份分镜' }))
  act(() => f.doc.flush())
  await f.user.click(screen.getByText('分镜核对历史（1）'))
  const history = () => within(screen.getByRole('list', { name: '分镜核对历史' }))
  expect(history().getByText(/当前内容已核对/)).toBeTruthy()
  const first = f.doc.get(f.boardId)!.production!.confirmations[0]!
  expect(first.actor).toEqual({ userId: LOCAL_PRINCIPAL.id, source: 'ui' })
  act(() => {
    setParams(f.doc, f.boardId, { shots: [{ ...f.shots[0], description: '收回信封' }] })
    f.doc.flush()
  })
  expect(history().queryByText(/当前内容已核对/)).toBeNull()
  expect(history().getByText(/内容已变化，待重新核对/)).toBeTruthy()
  await f.user.click(screen.getByRole('button', { name: '我已人工核对这份分镜' }))
  act(() => {
    for (const canvasId of ['c', 'other'])
      expect(
        confirmProductionContent(f.doc, {
          scope: { canvasId, boardId: f.boardId },
          expectedSnapshot: productionContentSnapshot(f.doc.get(f.boardId))!,
          version: 'v-extra',
          userId: 'reviewer',
        }),
      ).toBe(true)
    f.doc.flush()
  })
  expect(history().getAllByRole('listitem')).toHaveLength(4)
  for (const label of [
    '当前内容已核对',
    '内容已变化，待重新核对',
    '同内容的旧核对',
    '历史范围，待重新核实',
  ])
    expect(history().getByText(new RegExp(label))).toBeTruthy()
  expect(history().getByTitle(`other / ${f.boardId}`).textContent).toContain('来源 other')
  expect(f.doc.get(f.boardId)!.production!.confirmations[0]).toEqual(first)
})
