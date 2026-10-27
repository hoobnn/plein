# 测试分层与浏览器验收

测试选择以要证明的行为为准。先找成本最低、仍能捕获同一回归的层，再决定是否需要浏览器。纯逻辑和服务端合同覆盖主要分支，组件测试覆盖 DOM 交互，e2e 只覆盖必须连接前后端和真实浏览器才能证明的关键旅程。

## 选择测试层

| 层                     | 适用行为                                                                     | 位置与运行方式                                            |
| ---------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| 纯逻辑单测             | 数据转换、参数校验、状态归约、权限判定、缓存键、文档操作                     | 与源码相邻的 `*.test.ts`；`pnpm exec vp test run <路径>`  |
| 服务端 HTTP / 合同测试 | 请求校验、状态码、响应结构、存储、任务生命周期、服务端恢复与隔离             | `apps/server/src/<领域>/*.test.ts`；复用 `src/testing.ts` |
| DOM 组件测试           | 输入、按钮状态、弹窗开关、列表加载 / 空 / 错误 / 重试、前端异步交互          | 与组件相邻的 `*.test.tsx`；按文件启用 happy-dom           |
| 真浏览器 e2e           | 跨前后端关键旅程、浏览器持久化与重载、真实下载、多人同步、实际渲染与输入边界 | `e2e/*.spec.ts`；保留用例标记 `@core`                     |

能抽成纯逻辑单测的行为不放进组件测试。只验证服务端的用例不因原来通过页面请求就继续保留为 e2e。一个旅程可以拆成不同层的证明：接口失败结构由合同测试证明，失败时保留用户输入由组件测试证明，浏览器端只留下必要的集成连接。

happy-dom 不做真实布局、GPU 渲染或浏览器媒体解码。组件测试里的元素存在、事件派发和状态断言，不能充当像素、遮挡、尺寸、拖拽命中、原生输入法或媒体播放验收。

## 新增 e2e 的准入判据

新增前说明该用例必须由真实浏览器证明的断点，并确认纯逻辑、HTTP 合同和 DOM 组件测试无法覆盖它。优先扩展已有关键旅程，避免为同一断点重复启动浏览器。通常包括：

- 从页面操作经过真实 API、文档同步或存储，再回到可见结果的关键创作路径。
- 刷新、断线、重连、跨页面或跨客户端后，浏览器持久化与服务端状态仍一致。
- 真实文件选择、下载字节、媒体加载、浏览器权限等平台行为。
- 画布 GPU 与 DOM 接线、实际布局或输入事件命中，确实会影响关键操作。

仅断言 class、颜色、圆角或固定间距的样式细节，不单独新增 e2e。涉及实际遮挡、不可点击、焦点逃逸等功能障碍时，先区分可由 DOM 事件证明的部分与必须依赖浏览器布局的部分。

主配置中的关键旅程使用 `@core`，文件中的旅程用例都应被选中。`desktop-updates.spec.ts` 是明确的例外：它继续进入 `pnpm e2e` 全量回归，作为桌面更新的独立验收，不加 `@core`。可在每条测试上加 tag，或为整文件的旅程包一层带 tag 的 describe：

```ts
import { test } from './fixtures'

test.describe('关键创作旅程', { tag: '@core' }, () => {
  // 将本文件保留的真实旅程测试放在这里。
})
```

现有的 `test('名称 @core', ...)` 和 `test('名称', { tag: '@core' }, ...)` 也兼容 `--grep @core`。`pnpm e2e:core` 是发版前的浏览器冒烟集；它不替代下列独立验收范围。

## 独立验收与共享基础设施

`@core` 证明关键创作旅程的浏览器接线，不能代替以下验收：

- `e2e/server-lifecycle.contract.mjs`：服务及临时目录的所有权、退出和回收，由 `pnpm verify` 运行。
- `e2e/*.auth.ts` 与 auth 配置：真实密码认证及会话生命周期，由 `pnpm e2e:auth` 运行。
- `e2e/desktop-updates.spec.ts`：桌面更新界面与桥接合同，进入主配置全量；也可用 `pnpm e2e:file e2e/desktop-updates.spec.ts` 单独运行。它不证明打包安装与真实更新源可用。
- `e2e/real/`：L4 真实付费验收，按独立授权和配置运行。
- `e2e/perf/` 与 bench 配置：性能及基准测量。
- dev / creation 配置：开发态副作用与自管服务重启的验收，不能仅凭生产构建通过就省略。

修改共享 e2e 辅助前，检查主配置及上述所有入口的引用，包括动态导入、命令行入口和 lifecycle 合同。仅删除无人使用的导出或文件；仍在模块内部使用的实现应收为私有。删除 spec 时同步检查 `package.json`、各 `playwright.*.config.ts`、脚本和文档中的路径。

DOM 依赖、共享测试辅助和测试配置统一维护。领域夹具优先放在领域内；确需修改共享入口时，说明受影响的调用方并运行相关合同，避免为单个测试改变全局环境、超时或重试策略。

## 新增与调整用例

1. 明确要证明的行为，包括输入、前置状态、请求和副作用、失败边界以及最终断言。
2. 按纯逻辑、服务端 HTTP / 合同、DOM 组件、真浏览器的顺序选择最低成本测试层。一个旅程混合多个行为时，分别覆盖各层负责的部分。
3. 保留真实被测逻辑，只替换外部边界。断言用户可见结果、数据合同与必要的「没有发生」副作用，不只断言 mock 被调用。
4. 替换已有回归测试时，先运行新测试；临时破坏对应生产行为，确认新测试因目标断言失败，立即还原并复跑。只改期望值或主动抛错不能证明测试有效。
5. 证明完整后再删除旧测试。部分替换时保留仍需浏览器证明的断点及 `@core` 标签；纯重复或仅验证样式细节的条目说明现有覆盖路径或删除理由。

覆盖关系、删除理由、失败注入结果及数量和耗时写入提交消息，不把一次性验收记录放入常驻文档。mock 测试通过不代表真实平台、GPU、打包桌面或人工验收通过。

## DOM 组件测试

文件头必须显式启用环境；其余纯逻辑测试继续使用默认 Node 环境。这使用 [Vitest 的按文件环境声明](https://vitest.dev/guide/environment.html)：

```tsx
// @vitest-environment happy-dom
```

`apps/web/src/testing/setup.ts` 仅在 DOM 环境导入浏览器辅助，让系统主题等模块在加载时就能订阅稳定的媒体查询对象；Node 测试只经过环境判断，不加载 DOM 依赖。

共享入口为 [`apps/web/src/testing/render.tsx`](../../apps/web/src/testing/render.tsx)，沿用 [Testing Library 的自定义 render / wrapper 方式](https://testing-library.com/docs/react-testing-library/setup/)。使用 `renderApp` 渲染真实组件；它包装实际的 `QueryClientProvider` 和 `DialogHost`，返回 Testing Library 渲染结果、`user` 与 `queryClient`。常用查询和事件工具 `screen`、`within`、`waitFor`、`act`、`fireEvent` 从同一入口导入。

应用的查询更新函数直接使用 singleton `queryClient`，因此测试渲染也使用它，并在每个测试结束时取消查询、清理缓存和挂载。测试默认关闭自动重试与窗口重新聚焦刷新，设置 `gcTime: Infinity` 避免留下垃圾回收计时器；离开用例后恢复原查询选项。专测重试时，在本用例中通过 `queryClient.setDefaultOptions(...)` 显式设置重试次数和延时。不要另建一个 QueryClient 却继续调用真实的全局缓存函数，否则读写会落在不同缓存。用 `renderApp` 的 `route` 选项设置实际 hash 路由，例如 `{ route: { name: 'canvas', id: canvas.id } }`；无需引入另一套路由 Provider。当前界面直接使用中文文案，不需要额外 i18n Provider。

共享辅助在每条用例前后恢复 `useCanvas`、`useSession`、`useTheme` 的初值及主题属性，并清理 storage、路由和未完成弹窗。用例应设置自己依赖的 store 状态；额外的 Zustand store 在文件顶层通过 `resetStoreAfterEach(store)` 注册。不要用 `vi.resetModules()` 反复创建另一份 React、store 或查询客户端，也不要对共享这些全局状态的 DOM 用例使用 `it.concurrent`。外部订阅、计时器和异步任务也必须结束后再离开用例。防抖或轮询测试可在渲染前调用 `vi.useFakeTimers()`；`renderApp` 会为 `user-event` 接好计时器推进，也支持 `userOptions` 覆盖。推进业务时间用 `await act(() => vi.advanceTimersByTimeAsync(ms))`，之后断言实际结果。测试 `App` 本身已经包含 `DialogHost` 时，传 `{ dialogs: false }` 避免重复宿主；额外领域上下文通过 `wrapper` 传入。

真实交互范例见 [`ProjectSwitcher.test.tsx`](../../apps/web/src/features/projects/ProjectSwitcher.test.tsx)：打开真实项目改名窗口，验证空白不能保存、原名称不提交，以及组字中的 Escape 不丢弃草稿、普通取消不写入。它保留真实组件、弹窗和 API client，仅替换 HTTP 边界。输入和点击优先用返回的 `user`；`isComposing` / `keyCode: 229` 等精确事件参数用 `fireEvent`。这验证应用对组字事件的处理，不声称模拟了操作系统输入法。

该范例的 `setup()` 准备 HTTP 响应、设置当前画布、渲染组件并打开弹窗；交互断言形态如下：

```tsx
it('组字中的取消键保留草稿', async () => {
  const { user, dialog, input, writes } = await setup()
  await user.clear(input)
  await user.type(input, '中文组字中的项目名称')
  fireEvent.keyDown(input, { key: 'Escape', isComposing: true })
  expect(screen.getByRole('dialog', { name: '重命名项目' })).toBe(dialog)
  expect(dialog.hasAttribute('data-closing')).toBe(false)
  expect(input.value).toBe('中文组字中的项目名称')
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(writes()).toHaveLength(0)
})
```

### HTTP 与 API client 替身

使用 [`apps/web/src/testing/fetch.ts`](../../apps/web/src/testing/fetch.ts) 的 `mockFetch(handler)`。handler 接收规范化的 `Request`，按 URL、method 和请求体判断，返回 `Response` 或 `Promise<Response>`；未匹配时返回 `undefined`。未匹配请求会立即失败，并在 teardown 时再次检查，避免组件捕获异常后把遗漏请求藏起来。替身尊重 `Request.signal`，取消时拒绝为 `AbortError`。用例结束时未完成的 mock 请求会被取消并令测试失败；延迟响应必须在用例中结算，不能跨用例继续写缓存。

`ProjectSwitcher.test.tsx` 中的 `project`、`canvas` 是带类型的固定夹具，读取接口按下面的方式声明。此例没有允许 PATCH，因此意外写入不会被空响应悄悄放行：

```ts
const fetch = mockFetch((request) => {
  const path = new URL(request.url).pathname
  if (request.method === 'GET' && path === `/api/projects/${project.id}`)
    return Response.json(project)
  if (request.method === 'GET' && path === `/api/projects/${project.id}/canvases`)
    return Response.json([canvas])
})
```

`mockFetch()` 返回 Vitest mock，可以检查调用次数和参数。组件测试的共享入口默认先安装拒绝全部请求的 mock；每条用例再声明自己需要的响应，不会意外连接本机服务。

保留真实 `api` client，使用 `Response.json(...)` 返回响应；错误分支返回实际错误状态和协议结构。不要为所有请求无条件返回成功，不要把正在验证的重试、缓存或错误处理函数 mock 掉。只有纯消费某个 client 方法、且不验证其网络行为的窄组件测试，才用 `vi.spyOn(api, '方法名')` 代替 HTTP；用后恢复 spy。

### 浏览器能力替身

[`apps/web/src/testing/browser.ts`](../../apps/web/src/testing/browser.ts) 提供 `mockMatchMedia` 和 `mockResizeObserver`。组件渲染辅助默认令 `(prefers-reduced-motion: reduce)` 为真，使状态测试不等待装饰动画；其他媒体查询默认为假。需要其他行为时，在该用例显式安装替身：

- `matchMedia`：调用 `mockMatchMedia((query) => ...)` 设置初值，再用返回对象的 `set(query, matches)` 驱动 change 通知，不能依靠 happy-dom 计算真实布局。
- `ResizeObserver`：调用 `mockResizeObserver()`，再用返回对象的 `resize(element, width, height)` 触发观察回调；DOM 中的零尺寸不代表页面实际尺寸。
- canvas / WebGL / Pixi：只测试 DOM 控件时，在控件与画布引擎的边界提供最小、可观测的替身；纯坐标、选择和文档逻辑留在对应包的 Node 单测。不要全局 mock 整个引擎、伪造一套总是成功的 WebGL 上下文。
- 需要 canvas 2D 方法的窄逻辑测试，只替换实际使用的 `getContext` 方法与返回值，并恢复 spy；涉及渲染结果则保留真浏览器测试。
- 布局、动画、媒体解码和原生浏览器交互无法由这些替身证明。等待可见状态变化使用 `findBy*` / `waitFor`，避免固定 sleep 掩盖异步顺序问题。

懒加载组件的交互测试应先触发真实入口，再在异步 `act` 中等待对应模块的真实 `import()` 完成，随后断言 DOM 状态。点击结束不代表模块已经加载；不要同步读取尚未挂载的对话框，也不要把冷加载编译时间算进短暂的 DOM 查询窗口。加载中、加载失败和迟到结果另用受控 Promise 验证；不靠预先导入、固定 sleep 或全局加长超时隐藏加载过程。

主动驱动观察器或媒体查询引起的 React 更新时，用 `act(() => ...)` 包裹。渲染辅助会在 teardown 恢复 globals、spy 和真实计时器。

```tsx
const media = mockMatchMedia((query) => query === '(prefers-reduced-motion: reduce)')
const observer = mockResizeObserver()
// 渲染待测组件、取得其真正订阅的容器 element 后：
act(() => {
  media.set('(max-width: 640px)', true)
  observer.resize(element, 320, 600)
})
```

## 服务端 HTTP / 合同测试

复用 [`apps/server/src/testing.ts`](../../apps/server/src/testing.ts)，不另起一套固定端口服务：

| 辅助                                           | 真实执行范围                                                                         | 适用场景                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------- |
| `bootServer()` + `request(server, path, init)` | 真实应用、中间件、路由、SQLite、资产目录、房间和业务服务；通过 Hono 调度，不监听端口 | 普通 HTTP 请求 / 响应、存储与任务合同    |
| `startTestServer()`                            | 调用生产 `startServer()`，默认 `127.0.0.1` + 系统分配的随机端口；返回 `base`         | 需要真实 `fetch` 传输或 WebSocket 的测试 |

每次启动默认创建隔离临时目录、开启本地 mock Provider，并关闭前端静态产物。用例内启动的服务在用例结束时关闭，`beforeAll` 启动的服务在文件结束时关闭；辅助创建的临时目录在文件结束时删除。模拟重启时先 `await close()`，再将同一 `dataDir` 传入下一次启动。调用方自带的数据目录由调用方负责清理。

`request()` 默认设置本机 `Host` 和 JSON `content-type`；请求体仍需 `JSON.stringify()`，自定义 `headers` 使用普通对象。例子中的 Host 是直接调用应用时的校验信息，不会占用该端口。

默认本机免登录模式视请求为 owner，不能据此声称已覆盖登录、会话或跨用户授权。认证合同通过 `env: { PLEIN_AUTH: 'password' }` 启动并发送真实会话请求；注入 principal 的子路由测试只证明该路由的权限判断。

典型范例：

- [`projects/routes.test.ts`](../../apps/server/src/projects/routes.test.ts)：`bootServer` + `request` 验证创建、查询、删除、404 和输入校验，断言真实响应及存储结果。
- [`runs/runs.test.ts`](../../apps/server/src/runs/runs.test.ts)：`startTestServer` + `fetch` 验证生成任务接受、重复请求 409、结果与状态写回。
- [`runs/job-read.test.ts`](../../apps/server/src/runs/job-read.test.ts)：owner / viewer、跨画布范围、缺失资源以及读取不得触发提交或写入的合同。

下面摘取 `projects/routes.test.ts` 已有的非法种类分支；完整断言与夹具参照该文件：

```ts
import { expect, it } from 'vite-plus/test'
import { bootServer, request } from '../testing'

it('非法资产种类返回输入错误', async () => {
  const { server } = await bootServer({ mock: false })
  const response = await request(server, '/api/library', {
    method: 'POST',
    body: JSON.stringify({ kind: 'monster', name: 'x' }),
  })
  expect(response.status).toBe(400)
})
```

任务测试可用 `createCanvas`、`addNode`、`mockSettings` 构造输入，以 `server.runs.wait(runId)` 等待任务完成。`until()` 只接收同步检查函数，不传异步 fetch。测试应检查状态码、响应结构、错误、存储和必要副作用，不能只检查请求成功或日志出现。mock Provider 通过只说明本地合同成立，L4 真实付费验收仍单独执行。

## 运行与协作边界

单测统一从仓库根目录使用 `pnpm exec vp test run <路径或过滤>`。组件测试仍由根 `vite.config.ts` 的 `test.projects` 发现，不单独开测试配置。完成改动后检查改动文件并运行相关包 typecheck：

```bash
pnpm exec vp test run apps/web/src/features/projects/ProjectSwitcher.test.tsx
pnpm exec vp test run apps/server/src/projects/routes.test.ts
pnpm exec vp check <改动文件...>
pnpm --filter @plein/web typecheck
```

多人共享机器时，各自先跑相关测试；需要浏览器回归时协调 worker 数，显式分配端口基准的运行使用互不重叠的范围：

```bash
PLEIN_E2E_BASE_PORT=<分配值> PLEIN_E2E_WORKERS=<分配值> pnpm e2e:file <负责的spec...>
```

全量 `pnpm e2e`、`pnpm e2e:core`、`pnpm verify` 和全量单测顺序运行，并预留独占测试窗口，避免资源争抢扭曲墙钟或引入时序抖动。全量失败先修根因，再重跑相应门禁；不通过加重试、放宽断言或降低覆盖率门槛掩盖失败。
