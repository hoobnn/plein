import { Scene, type Engine } from '@plein/canvas-core'
import type { PleinDoc } from '@plein/doc'
import { vi } from 'vite-plus/test'

/** 保留真实文档与场景，仅替代 GPU 视口和相机事件。 */
export function mediaTestEngine(doc: PleinDoc): Engine {
  const subscribe = () => () => {}
  return {
    doc,
    scene: new Scene(doc),
    state: { tool: 'select' },
    selection: { set: vi.fn(), values: () => [], has: () => true, onChange: subscribe },
    onStateChange: subscribe,
    onViewChange: subscribe,
    onMove: subscribe,
    onActivate: subscribe,
    setTool: vi.fn(),
    zoomToFit: vi.fn(),
    visibleIds: [],
    highDetail: false,
    camera: {
      onChange: subscribe,
      onInsetsChange: subscribe,
      insets: { left: 0, right: 0, top: 0, bottom: 0 },
      width: 1000,
      height: 800,
      zoom: 1,
      viewRect: { x: 0, y: 0, w: 1000, h: 800 },
      worldToScreen: (x: number, y: number) => ({ x, y }),
      centerOn: vi.fn(),
    },
  } as unknown as Engine
}
