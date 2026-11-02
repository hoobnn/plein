// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { createDoc, createElement } from '@plein/doc'
import { type PreparedInput } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import type { NodeInfo } from '../../canvas/nodes'
import { renderApp, screen } from '../../testing/render'
import { InputPreview } from './InputPreview'

it('同一场景的多个视角分别显示，缺图视角保留阻断说明', async () => {
  const doc = createDoc()
  try {
    const id = createElement(doc, { kind: 'node', x: 0, y: 0, w: 100, h: 100 })
    const data: PreparedInput = {
      v: 1,
      nodeId: id,
      nodeType: 'plein/image',
      preparedAt: 1,
      status: 'blocked',
      params: {},
      inputs: {},
      sent: [
        {
          index: 1,
          token: '图1',
          assetId: 'a'.repeat(64),
          name: '教室（门口）',
          origins: ['mention'],
        },
      ],
      notices: [],
      blocked: [{ code: 'required_no_image', message: '教室（空机位）没有参考图' }],
      refs: [
        {
          elementId: 'scene',
          kind: 'scene',
          name: '教室（门口）',
          required: false,
          available: ['a'.repeat(64)],
          sent: ['a'.repeat(64)],
        },
        {
          elementId: 'scene',
          kind: 'scene',
          name: '教室（空机位）',
          required: true,
          available: [],
          sent: [],
          reason: 'no_image',
        },
      ],
    }
    const { user, unmount } = renderApp(
      <InputPreview
        engine={{ doc } as Engine}
        el={doc.get(id)!}
        node={{ paramsSchema: {} } as NodeInfo}
        data={data}
        loading={false}
        error={null}
        onRetry={() => {}}
      />,
    )
    await user.click(screen.getByRole('button', { name: /实际输入/ }))
    // 视角清单不再在这里重复列出：送入的看顶部参考素材区，缺图的看「未送入」。
    expect(screen.getByRole('button', { name: /实际输入/ }).textContent).toContain('1 张参考图')
    expect(screen.getByRole('alert').textContent).toContain('空机位）没有参考图')
    // 必需参考是节点参数，留在「有效参数」里。
    expect(screen.getByText('教室（空机位）')).toBeTruthy()
    unmount()
  } finally {
    doc.destroy()
  }
})
